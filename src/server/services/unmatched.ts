/** Explicit decisions about received sheets belonging to an old draw. */
import { and, eq, inArray } from "drizzle-orm";
import { canonicalJson } from "@/domain/schedule";
import { auditLog, conflicts, getDbDriver, sheets, type Tx } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "./audit";
import { withTransaction, type ServiceContext, type Queryable } from "./context";
import {
  loadSheetSlot,
  readCurrentSheet,
  refuseWhenPublished,
  writeSheetVersion,
  type SheetSlot,
} from "./sheets";
export const ORPHAN_ACTIONS = ["sheet.orphan_attached", "sheet.orphan_discarded"] as const;
export async function orphanDecisions(db: Queryable, tournamentId: string) {
  return db
    .select({ assignmentId: auditLog.assignmentId, after: auditLog.after })
    .from(auditLog)
    .where(
      and(eq(auditLog.tournamentId, tournamentId), inArray(auditLog.action, [...ORPHAN_ACTIONS])),
    );
}
async function oldSheet(tx: Tx, tournamentId: string, assignmentId: string) {
  const slot = await loadSheetSlot(tx, tournamentId, assignmentId, {
    lock: true,
    allowRetired: true,
    for: "organiser",
  });
  refuseWhenPublished(slot.division, "organiser");
  if (slot.assignment.retiredAt === null)
    throw errors.validation("This sheet still belongs to the current draw.");
  // Match resolveConflict’s conflict-before-sheet lock order. Retired judge
  // submissions cannot introduce new conflicts after this slot was retired.
  const conflictQuery = tx
    .select()
    .from(conflicts)
    .where(
      and(
        eq(conflicts.tournamentId, tournamentId),
        eq(conflicts.assignmentId, assignmentId),
        eq(conflicts.status, "open"),
      ),
    )
    .$dynamic();
  const openConflicts = await (getDbDriver() === "pg"
    ? conflictQuery.for("update")
    : conflictQuery);
  const query = tx
    .select()
    .from(sheets)
    .where(and(eq(sheets.tournamentId, slot.tournament.id), eq(sheets.assignmentId, assignmentId)))
    .$dynamic();
  await (getDbDriver() === "pg" ? query.for("update") : query);
  const current = await readCurrentSheet(tx, slot.tournament.id, assignmentId);
  if (!current.row) throw errors.validation("No received sheet exists on this old draw slot.");
  const decisions = await orphanDecisions(tx, slot.tournament.id);
  if (
    decisions.some(
      (d) =>
        d.assignmentId === assignmentId &&
        typeof d.after === "object" &&
        d.after !== null &&
        "version" in d.after &&
        d.after.version === current.version,
    )
  )
    throw errors.validation("This old sheet already has a recorded decision.");
  return {
    slot,
    current: current.row,
    openConflictIds: openConflicts.filter((c) => c.status === "open").map((c) => c.id),
  };
}
function reasonRequired(reason: string) {
  if (!reason.trim())
    throw errors.validation("Give a reason. It is kept with the original sheet in the history.");
}
export async function discardOrphan(
  ctx: ServiceContext,
  input: { tournamentId: string; assignmentId: string; reason: string },
) {
  reasonRequired(input.reason);
  return withTransaction(ctx, async (tx) => {
    const { slot, current, openConflictIds } = await oldSheet(
      tx,
      input.tournamentId,
      input.assignmentId,
    );
    await supersedeOldConflicts(
      tx,
      ctx,
      input.tournamentId,
      openConflictIds,
      current.version,
      input.reason,
      "discard",
    );
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: ORPHAN_ACTIONS[1],
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      after: {
        version: current.version,
        decision: "discard",
        supersededConflictIds: openConflictIds,
      },
    });
    return { assignmentId: input.assignmentId, version: current.version };
  });
}
function compatible(old: SheetSlot, next: SheetSlot, map: Record<string, string>) {
  if (
    old.assignment.successorId !== next.assignment.id ||
    old.assignment.judgeId !== next.assignment.judgeId ||
    old.assignment.identity.round !== next.assignment.identity.round ||
    old.division.code !== next.division.code
  )
    throw errors.validation(
      "Choose this sheet’s live successor for the same judge, division and round.",
    );
  const speakers = old.assignment.identity.speakers;
  if (
    Object.keys(map).length !== speakers.length ||
    speakers.some((s) => map[s.id] !== s.id) ||
    canonicalJson(speakers) !== canonicalJson(next.assignment.identity.speakers)
  )
    throw errors.validation(
      "Only the same four debaters, teams, sides and positions can carry their original scores forward. Enter a new sheet for a changed matchup.",
    );
}
export async function attachOrphan(
  ctx: ServiceContext,
  input: {
    tournamentId: string;
    assignmentId: string;
    successorId: string;
    speakerMap: Record<string, string>;
    reason: string;
  },
) {
  reasonRequired(input.reason);
  return withTransaction(ctx, async (tx) => {
    const { slot, current, openConflictIds } = await oldSheet(
      tx,
      input.tournamentId,
      input.assignmentId,
    );
    const next = await loadSheetSlot(tx, input.tournamentId, input.successorId, {
      lock: true,
      for: "organiser",
    });
    refuseWhenPublished(next.division, "organiser");
    compatible(slot, next, input.speakerMap);
    if ((await readCurrentSheet(tx, input.tournamentId, input.successorId)).row)
      throw errors.validation(
        "The successor already has a received sheet. Review that sheet before deciding what to keep.",
      );
    const version = await writeSheetVersion(tx, {
      tournamentId: input.tournamentId,
      assignmentId: input.successorId,
      expectedVersion: 0,
      payload: {
        scores: current.scores,
        sideFlipped: current.sideFlipped,
        roleSwaps: current.roleSwaps,
      },
      source: "organiser_correction",
      actor: { type: "organiser", id: ctx.actor.id, name: ctx.actor.name },
      reason: input.reason,
      receivedAt: ctx.now(),
    });
    if (!version)
      throw errors.validation(
        "Another sheet reached the successor first. Reload before making this decision.",
      );
    await supersedeOldConflicts(
      tx,
      ctx,
      input.tournamentId,
      openConflictIds,
      current.version,
      input.reason,
      "attach",
    );
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: ORPHAN_ACTIONS[0],
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      after: {
        version: current.version,
        decision: "attach",
        supersededConflictIds: openConflictIds,
        successorId: input.successorId,
        successorVersion: version.version,
        speakerMap: input.speakerMap,
      },
    });
    return {
      assignmentId: input.assignmentId,
      successorId: input.successorId,
      version: version.version,
    };
  });
}

async function supersedeOldConflicts(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  ids: string[],
  version: number,
  reason: string,
  decision: "attach" | "discard",
) {
  if (!ids.length) return;
  const at = ctx.now();
  await tx
    .update(conflicts)
    .set({
      status: "superseded",
      resolvedAt: at,
      resolution: {
        choice: "keep",
        reason: `Old draw ${decision === "attach" ? "attachment keeps the received sheet" : "set-aside excludes the old sheet"}: ${reason.trim()}`,
        resolvedBy: ctx.actor.name,
        resolvedAt: at.toISOString(),
        resultingVersion: version,
      },
    })
    .where(
      and(
        eq(conflicts.tournamentId, tournamentId),
        inArray(conflicts.id, ids),
        eq(conflicts.status, "open"),
      ),
    );
}
