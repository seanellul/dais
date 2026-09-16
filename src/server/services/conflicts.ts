/**
 * Two versions of a sheet, and how the organiser settles them.
 *
 * A conflict is data, never an error: the judge's stale submission is kept
 * in `conflicts` with the payload it carried, the organiser sees both
 * versions side by side and chooses. Every choice, including "keep what we
 * have", writes a new audited version, so the history shows that a decision
 * was made and by whom. The judge's stored receipt is then rewritten to a
 * 200 with the choice in it, so the phone's next retry converges instead of
 * retrying a 409 for ever (the prototype's receipt rewrite, on a real row).
 */
import { and, asc, eq } from "drizzle-orm";

import type { SheetPayload, SheetScores, SpeakerScore } from "@/domain/types";
import {
  assignments,
  conflicts,
  debates,
  getDbDriver,
  judges,
  sheetVersions,
  sheets,
  submissions,
  type AssignmentRow,
  type ConflictResolution,
  type ConflictRow,
  type SheetVersionRow,
  type StoredResponse,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, actorTypeOf, recordAudit } from "./audit";
import { withTransaction, type Queryable, type ServiceContext } from "./context";
import {
  loadSheetSlot,
  organiserStale,
  payloadOf,
  readCurrentSheet,
  refuseWhenPublished,
  requestKeyOf,
  validatePayload,
  versionSummary,
  writeSheetVersion,
  type Receipt,
  type ResolutionChoice,
} from "./sheets";

/** An open two-versions case with what the organiser needs to compare. */
export interface OpenConflict {
  conflict: ConflictRow;
  assignment: AssignmentRow;
  judgeName: string;
  divisionCode: string;
  round: number;
  roomName: string;
  /** The stored version the judge's submission clashed with; null if none is stored. */
  current: SheetVersionRow | null;
}

/** Open conflicts for the tournament (or one division), oldest first. */
export async function listOpenConflicts(
  db: Queryable,
  tournamentId: string,
  divisionCode?: string,
): Promise<OpenConflict[]> {
  const rows = await db
    .select({
      conflict: conflicts,
      assignment: assignments,
      judgeName: judges.name,
      divisionCode: debates.divisionCode,
      current: sheetVersions,
    })
    .from(conflicts)
    .innerJoin(
      assignments,
      and(
        eq(assignments.tournamentId, conflicts.tournamentId),
        eq(assignments.id, conflicts.assignmentId),
      ),
    )
    .innerJoin(debates, eq(debates.id, assignments.debateId))
    .innerJoin(judges, eq(judges.id, conflicts.judgeId))
    .leftJoin(
      sheets,
      and(
        eq(sheets.tournamentId, conflicts.tournamentId),
        eq(sheets.assignmentId, conflicts.assignmentId),
      ),
    )
    .leftJoin(sheetVersions, eq(sheetVersions.id, sheets.currentVersionId))
    .where(
      divisionCode === undefined
        ? and(eq(conflicts.tournamentId, tournamentId), eq(conflicts.status, "open"))
        : and(
            eq(conflicts.tournamentId, tournamentId),
            eq(conflicts.status, "open"),
            eq(debates.divisionCode, divisionCode),
          ),
    )
    .orderBy(asc(conflicts.createdAt), asc(conflicts.id));
  return rows.map((row) => ({
    conflict: row.conflict,
    assignment: row.assignment,
    judgeName: row.judgeName,
    divisionCode: row.divisionCode,
    round: row.assignment.identity.round,
    roomName: row.assignment.display.roomName,
    current: row.current,
  }));
}

export { listOpenConflicts as listOpen };

export interface ResolveConflictInput {
  tournamentId: string;
  conflictId: string;
  /** keep the stored version, take the incoming one, or keep the numbers and add the incoming comments. */
  choice: ResolutionChoice;
  reason: string;
}

export interface ResolveConflictResult {
  conflictId: string;
  assignmentId: string;
  choice: ResolutionChoice;
  /** The version the decision produced. */
  version: number;
  /** ISO 8601. */
  receivedAt: string;
}

const CHOICES: ReadonlySet<string> = new Set(["keep", "incoming", "merge_comments"]);

/**
 * Settles two versions of a sheet. Writes the chosen content as a new
 * version with source `organiser_resolution`, marks the conflict resolved,
 * rewrites the judge's receipt to a 200 that names the choice, and records
 * the decision with its reason.
 *
 * Throws `not_found` for an unknown conflict, `validation` when it is
 * already settled or the reason is blank, `division_finalized` (423) when
 * the division is published, and `version_conflict` (409) when the sheet
 * changed while the organiser was deciding (reload and decide again).
 */
export async function resolveConflict(
  ctx: ServiceContext,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  if (!CHOICES.has(input.choice)) {
    throw errors.validation(
      "Choose to keep the current sheet, use the incoming one, or add its comments.",
    );
  }
  if (input.reason.trim().length === 0) {
    throw errors.validation("Give a reason for this decision. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  return withTransaction(ctx, async (tx) => {
    const conflict = await lockConflict(tx, input.tournamentId, input.conflictId);
    if (conflict.status !== "open") {
      throw errors.validation("These two versions have already been settled.", {
        resolution: conflict.resolution,
      });
    }
    // A retired slot can still be settled: the sheet is orphaned either way,
    // and the decision belongs in the history.
    const slot = await loadSheetSlot(tx, input.tournamentId, conflict.assignmentId, {
      lock: true,
      for: "organiser",
      allowRetired: true,
    });
    refuseWhenPublished(slot.division, "organiser");
    const current = await readCurrentSheet(tx, input.tournamentId, conflict.assignmentId);
    if (current.row === null && input.choice !== "incoming") {
      throw errors.validation("There is no received sheet to keep. Use the incoming version.");
    }
    const chosen = validatePayload(
      chosenPayload(input.choice, conflict.incoming, current.row ? payloadOf(current.row) : null),
      slot,
    );

    const resolvedAt = ctx.now();
    const version = await writeSheetVersion(tx, {
      tournamentId: input.tournamentId,
      assignmentId: conflict.assignmentId,
      expectedVersion: current.version,
      payload: chosen,
      source: "organiser_resolution",
      actor: { type: actorTypeOf(ctx.actor), id: ctx.actor.id, name: ctx.actor.name },
      reason: input.reason,
      requestKey: requestKeyOf(conflict.judgeId, conflict.requestId),
      receivedAt: resolvedAt,
    });
    if (version === null) throw organiserStale(current.version + 1);

    const resolution: ConflictResolution = {
      choice: input.choice,
      reason: input.reason.trim(),
      resolvedBy: ctx.actor.name,
      resolvedAt: resolvedAt.toISOString(),
      resultingVersion: version.version,
    };
    await tx
      .update(conflicts)
      .set({ status: "resolved", resolution, resolvedAt })
      .where(eq(conflicts.id, conflict.id));
    await rewriteReceipt(tx, conflict, version, resolution);

    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.conflictResolved,
      entityType: "conflict",
      entityId: conflict.id,
      assignmentId: conflict.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      before: {
        kind: conflict.kind,
        baseVersion: conflict.baseVersion,
        currentVersion: conflict.currentVersion,
        current: current.row ? versionSummary(current.row) : null,
      },
      after: { choice: input.choice, ...versionSummary(version) },
    });
    return {
      conflictId: conflict.id,
      assignmentId: conflict.assignmentId,
      choice: input.choice,
      version: version.version,
      receivedAt: resolvedAt.toISOString(),
    };
  });
}

/** The conflict row, locked on Postgres so two organisers cannot settle it twice. */
async function lockConflict(
  tx: Tx,
  tournamentId: string,
  conflictId: string,
): Promise<ConflictRow> {
  const query = tx
    .select()
    .from(conflicts)
    .where(and(eq(conflicts.tournamentId, tournamentId), eq(conflicts.id, conflictId)))
    .limit(1)
    .$dynamic();
  const [row] = await (getDbDriver() === "pg" ? query.for("update") : query);
  if (!row) throw errors.notFound("That sheet's second version");
  return row;
}

/**
 * The content each choice produces. "merge_comments" keeps the stored
 * numbers and sides and takes the incoming comments where the judge wrote
 * any; a blank incoming comment never erases a stored one.
 */
export function chosenPayload(
  choice: ResolutionChoice,
  incoming: SheetPayload,
  current: SheetPayload | null,
): SheetPayload {
  if (choice === "incoming" || current === null) return incoming;
  if (choice === "keep") return current;
  return { ...current, scores: mergeComments(current.scores, incoming.scores) };
}

function mergeComments(current: SheetScores, incoming: SheetScores): SheetScores {
  const merged: SheetScores = {};
  for (const [speakerId, score] of Object.entries(current)) {
    const theirs: SpeakerScore | undefined = incoming[speakerId];
    merged[speakerId] = {
      ...score,
      www: theirs && theirs.www.trim().length > 0 ? theirs.www : score.www,
      ebi: theirs && theirs.ebi.trim().length > 0 ? theirs.ebi : score.ebi,
    };
  }
  return merged;
}

/**
 * The judge's phone keeps retrying the same request id until it gets a 200.
 * After the decision, that 200 is the version the decision produced, with
 * the choice in it so the phone can tell the judge what happened.
 */
async function rewriteReceipt(
  tx: Tx,
  conflict: ConflictRow,
  version: SheetVersionRow,
  resolution: ConflictResolution,
): Promise<void> {
  const receipt: Receipt = {
    status: "received",
    version: version.version,
    receivedAt: resolution.resolvedAt,
    resolution: resolution.choice,
  };
  await tx
    .update(submissions)
    .set({
      state: "done",
      httpStatus: 200,
      response: receipt as unknown as StoredResponse,
      completedAt: new Date(resolution.resolvedAt),
    })
    .where(
      and(
        eq(submissions.tournamentId, conflict.tournamentId),
        eq(submissions.judgeId, conflict.judgeId),
        eq(submissions.requestId, conflict.requestId),
      ),
    );
}
