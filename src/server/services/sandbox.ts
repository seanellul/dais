/**
 * Sandbox reset: put a sandbox or demo tournament back to the state it was
 * created in. `createDemoTournament` and `importBackup` store a creation
 * snapshot (kind `manual`, label "Creation"); a reset deletes every child
 * row and inserts the snapshot's rows again with their original ids,
 * through the same helpers `restoreInPlace` uses. A live tournament is
 * never reset: it is restored from a backup, with a reason.
 *
 * The revision does not rewind. Setup revisions written since creation are
 * history and stay, so the tournament's revision moves forward past them
 * (as a restore does) and the restored schedule is recorded under the new
 * number; the next draw save then inserts `revision + 1` without a clash.
 * When the draw was published at creation it is published again under the
 * new revision, so the dashboard does not report that the draw changed.
 */
import { and, asc, eq } from "drizzle-orm";

import { parseSettings } from "@/domain/settings";
import { auditLog, tournamentSnapshots, tournaments, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import {
  CREATION_SNAPSHOT_LABEL,
  deleteTournamentChildren,
  insertTournamentTables,
  recordSetupRevision,
  tablesFromSnapshot,
} from "./backup";
import { withTransaction, type ServiceContext } from "./context";
import { DRAW_PUBLISHED_ACTION, publishDraw } from "./draw";
import { lockTournament } from "./simulate";

export interface ResetSandboxInput {
  tournamentId: string;
}

export interface ResetSandboxResult {
  /** The creation snapshot that was restored. */
  snapshotId: string;
  resetAt: string;
  /** The tournament's new revision: one past the highest it has had. */
  revision: number;
}

/** Restores the tournament from its creation snapshot. Refused for a live tournament. */
export async function resetSandbox(
  ctx: ServiceContext,
  input: ResetSandboxInput,
): Promise<ResetSandboxResult> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, input.tournamentId);
    if (tournament.kind === "live") {
      throw errors.validation(
        "Only a sandbox or demo tournament can be reset. A live tournament is restored from a backup instead.",
      );
    }
    const [snapshot] = await tx
      .select()
      .from(tournamentSnapshots)
      .where(
        and(
          eq(tournamentSnapshots.tournamentId, tournament.id),
          eq(tournamentSnapshots.kind, "manual"),
          eq(tournamentSnapshots.label, CREATION_SNAPSHOT_LABEL),
        ),
      )
      .orderBy(asc(tournamentSnapshots.createdAt), asc(tournamentSnapshots.id))
      .limit(1);
    if (!snapshot) {
      throw errors.validation("This sandbox has no creation snapshot to go back to.");
    }

    const { tournament: original, tables } = tablesFromSnapshot(snapshot.body);
    const settings = parseSettings(original.settings);
    if (!settings.ok) {
      throw errors.internal(new Error(`Snapshot ${snapshot.id} has invalid settings.`));
    }

    await deleteTournamentChildren(tx, tournament.id);
    await insertTournamentTables(tx, tournament.id, tables);

    const now = ctx.now();
    const revision = Math.max(tournament.revision, original.revision) + 1;
    await tx
      .update(tournaments)
      .set({
        settings: settings.data,
        scoringPolicy: original.scoringPolicy,
        drawSeed: original.drawSeed,
        status: original.status,
        revision,
        demoLastResetAt: now,
        updatedAt: now,
      })
      .where(eq(tournaments.id, tournament.id));
    await recordSetupRevision(tx, ctx, tournament.id, revision);
    if (await drawPublishedAt(tx, tournament.id, original.revision)) {
      await publishDraw(tx, ctx, tournament.id, { baseRevision: revision });
    }

    await recordAudit(tx, ctx, {
      tournamentId: tournament.id,
      action: AUDIT_ACTIONS.demoReset,
      entityType: "tournament",
      entityId: tournament.id,
      before: { revision: tournament.revision },
      after: { revision, snapshotId: snapshot.id },
    });
    ctx.log.info({ tournamentId: tournament.id, snapshotId: snapshot.id }, "Sandbox reset");
    return { snapshotId: snapshot.id, resetAt: now.toISOString(), revision };
  });
}

/**
 * True when the draw was published while the tournament stood at
 * `revision`. Revisions only move forward (a reset or restore skips past
 * every number used before), so a "draw published" history row naming the
 * creation revision can only have been written in the creation state. A
 * tournament created without a draw has no such row, and `publishDraw`
 * would refuse its empty schedule anyway.
 */
async function drawPublishedAt(tx: Tx, tournamentId: string, revision: number): Promise<boolean> {
  const rows = await tx
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(
      and(eq(auditLog.tournamentId, tournamentId), eq(auditLog.action, DRAW_PUBLISHED_ACTION)),
    );
  return rows.some((row) => (row.after as { revision?: unknown } | null)?.revision === revision);
}
