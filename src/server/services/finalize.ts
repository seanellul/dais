/**
 * Publishing a division's results, and reopening them.
 *
 * Publishing is the one moment results become a fact: the division row gets
 * `finalized_at`, the outlier policy is stamped on it so a later policy edit
 * cannot change a published result, and a whole-tournament snapshot is
 * taken first so the moment can be inspected or restored. Judge submissions
 * for the division are refused with 423 from then on.
 *
 * Publishing is gated. Every gate is a plain sentence, and all of them are
 * returned together so the organiser sees the whole list rather than one
 * problem at a time:
 * - the draw for the division is complete (every team in every round);
 * - no sheet in the division has two versions waiting for a decision;
 * - every expected sheet has been received or waived;
 * - every debater can be scored, or the organiser has taken them out; and
 * - every team is rankable, or the organiser has said how to rank it.
 *
 * Reopening needs a reason, takes a snapshot too, and clears the
 * publication. Sheets keep their versions; nothing else changes.
 */
import { and, eq } from "drizzle-orm";

import { validateSchedule } from "@/domain/schedule";
import type { LoppingPolicy } from "@/domain/scoring";
import { divisions, getDbDriver, type DivisionRow, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { withTransaction, type Queryable, type ServiceContext } from "./context";
import { listOpenConflicts } from "./conflicts";
import { loadGraph, toSchedule, type TournamentGraph } from "./graph";
import { buildResultsView, parseScoringPolicy } from "./results";
import { snapshotTournament } from "./snapshots";

export interface FinalizeDivisionInput {
  tournamentId: string;
  divisionCode: string;
  /** The organiser has read the policy sentence on the publish screen. */
  acknowledgePolicy: boolean;
}

export interface FinalizeDivisionResult {
  divisionCode: string;
  /** ISO 8601. */
  finalizedAt: string;
  finalizedBy: string;
  snapshotId: string;
  /** The policy stamped on the division. */
  policy: LoppingPolicy;
}

/**
 * Publishes the division's results. Throws `validation` with
 * `details.blockers` (plain sentences) when a gate fails, and
 * `division_finalized` (423) when the results are already published.
 */
export async function finalizeDivision(
  ctx: ServiceContext,
  input: FinalizeDivisionInput,
): Promise<FinalizeDivisionResult> {
  if (input.acknowledgePolicy !== true) {
    throw errors.validation("Read the outlier policy and tick the box before publishing results.", {
      issues: [{ path: "acknowledgePolicy", message: "Acknowledge the policy first." }],
    });
  }
  return withTransaction(ctx, async (tx) => {
    const division = await lockDivision(tx, input.tournamentId, input.divisionCode);
    if (division.finalizedAt !== null) {
      throw errors.divisionFinalized({
        divisionCode: division.code,
        finalizedAt: division.finalizedAt.toISOString(),
      });
    }
    const graph = await loadGraph(tx, input.tournamentId);
    const blockers = await collectBlockers(tx, graph, input.divisionCode);
    if (blockers.length > 0) {
      throw errors.validation(
        `Results for ${division.name} can't be published yet. ${blockers.length === 1 ? "One thing" : `${blockers.length} things`} still need attention.`,
        { blockers },
      );
    }

    const policy = parseScoringPolicy(graph.tournament.scoringPolicy);
    const snapshot = await snapshotTournament(tx, ctx, input.tournamentId, "pre_finalize", {
      label: `Before publishing ${division.name}`,
    });
    const finalizedAt = ctx.now();
    await tx
      .update(divisions)
      .set({
        finalizedAt,
        finalizedBy: ctx.actor.name,
        finalizedAtRevision: graph.tournament.revision,
        policySnapshot: { ...policy },
      })
      .where(eq(divisions.id, division.id));
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.divisionFinalized,
      entityType: "division",
      entityId: division.id,
      divisionCode: division.code,
      after: {
        finalizedAt: finalizedAt.toISOString(),
        revision: graph.tournament.revision,
        snapshotId: snapshot.id,
        policy,
      },
    });
    return {
      divisionCode: division.code,
      finalizedAt: finalizedAt.toISOString(),
      finalizedBy: ctx.actor.name,
      snapshotId: snapshot.id,
      policy,
    };
  });
}

export interface ReopenDivisionInput {
  tournamentId: string;
  divisionCode: string;
  reason: string;
}

export interface ReopenDivisionResult {
  divisionCode: string;
  /** ISO 8601. */
  reopenedAt: string;
  snapshotId: string;
}

/**
 * Reopens published results so sheets and overrides can change again.
 * The reason is mandatory and goes in the history; a snapshot is taken
 * first so the published state can always be inspected.
 */
export async function reopenDivision(
  ctx: ServiceContext,
  input: ReopenDivisionInput,
): Promise<ReopenDivisionResult> {
  if (input.reason.trim().length === 0) {
    throw errors.validation("Give a reason for reopening. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  return withTransaction(ctx, async (tx) => {
    const division = await lockDivision(tx, input.tournamentId, input.divisionCode);
    if (division.finalizedAt === null) {
      throw errors.validation(`Results for ${division.name} are not published.`);
    }
    const snapshot = await snapshotTournament(tx, ctx, input.tournamentId, "pre_unlock", {
      label: `Before reopening ${division.name}`,
    });
    const reopenedAt = ctx.now();
    await tx
      .update(divisions)
      .set({
        finalizedAt: null,
        finalizedBy: null,
        finalizedAtRevision: null,
        policySnapshot: null,
      })
      .where(eq(divisions.id, division.id));
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.divisionReopened,
      entityType: "division",
      entityId: division.id,
      divisionCode: division.code,
      reason: input.reason,
      before: {
        finalizedAt: division.finalizedAt.toISOString(),
        finalizedBy: division.finalizedBy,
        policy: division.policySnapshot,
      },
      after: { reopenedAt: reopenedAt.toISOString(), snapshotId: snapshot.id },
    });
    return {
      divisionCode: division.code,
      reopenedAt: reopenedAt.toISOString(),
      snapshotId: snapshot.id,
    };
  });
}

/**
 * What stands in the way of publishing, as plain sentences, for the publish
 * checklist. Empty when the division can be published now.
 */
export async function publishBlockers(
  db: Queryable,
  tournamentId: string,
  divisionCode: string,
): Promise<string[]> {
  const graph = await loadGraph(db, tournamentId);
  if (!graph.divisions.some((division) => division.code === divisionCode)) {
    throw errors.notFound("That division");
  }
  return collectBlockers(db, graph, divisionCode);
}

/** The division row, locked on Postgres so two publishes (or a publish and a submit) cannot cross. */
async function lockDivision(tx: Tx, tournamentId: string, code: string): Promise<DivisionRow> {
  const query = tx
    .select()
    .from(divisions)
    .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, code)))
    .limit(1)
    .$dynamic();
  const [row] = await (getDbDriver() === "pg" ? query.for("update") : query);
  if (!row) throw errors.notFound("That division");
  return row;
}

/** The four gates, each as sentences the organiser can act on. */
async function collectBlockers(
  db: Queryable,
  graph: TournamentGraph,
  divisionCode: string,
): Promise<string[]> {
  const blockers: string[] = [];

  const schedule = toSchedule(graph);
  const draw = validateSchedule(schedule, { requireComplete: true, divisionCode });
  if (!draw.ok) {
    for (const issue of draw.issues) {
      if (issue.severity === "blocker") blockers.push(`The draw is not complete: ${issue.message}`);
    }
  }

  const open = await listOpenConflicts(db, graph.tournament.id, divisionCode);
  for (const item of open) {
    blockers.push(
      `Round ${item.round}, ${item.roomName}: the sheet from ${item.judgeName} has two versions. Choose which one to keep.`,
    );
  }

  const view = buildResultsView(graph, divisionCode);
  blockers.push(...view.completeness.blockers);
  return blockers;
}
