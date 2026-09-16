/**
 * The scoring write path: how a sheet becomes a stored version.
 *
 * Four doors lead to `sheet_versions`:
 * - `receiveSheet`: a judge's phone submits (or re-submits) a sheet.
 * - `enterPaperSheet`: the organiser types in a paper sheet.
 * - `correctSheet`: the organiser changes a received sheet, with a reason.
 * - `enterHandoff`: the organiser enters what a judge's phone could not send.
 *
 * All four share the same guards (the sheet's slot must be live, the
 * division must not be published, the payload must fit the rubric) and the
 * same write: append a version, then move the sheet's current-version pointer
 * with a compare-and-set. Two writers can never both win: the loser sees
 * zero rows and, for a judge, that becomes "two versions" for the organiser
 * to settle rather than a lost update.
 *
 * A judge submission is idempotent. Every request id gets a receipt in
 * `submissions` inside the same transaction as the write, so a retry with
 * the same content gets the same answer back (a stored 409 as well as a
 * stored 200), and a retry after the organiser settled two versions gets the
 * rewritten 200 (see `./conflicts`). Errors are not stored: a submission
 * refused because the division is published is re-evaluated on the next
 * try, which is how a phone resumes by itself after the organiser reopens.
 */
import { and, asc, eq } from "drizzle-orm";

import { canonicalJson } from "@/domain/schedule";
import { parseSheetPayload } from "@/domain/sheet";
import type { SheetPayload, SheetScores } from "@/domain/types";
import {
  assignments,
  conflicts,
  debates,
  divisions,
  getDbDriver,
  judges,
  sheetVersions,
  sheetWaivers,
  sheets,
  submissions,
  tournaments,
  type AssignmentRow,
  type ConflictResolution,
  type ConflictRow,
  type DivisionRow,
  type JudgeRow,
  type SheetVersionRow,
  type SheetWaiverRow,
  type StoredResponse,
  type TournamentRow,
  type Tx,
} from "@/server/db";
import { AppError, errors } from "@/server/errors";

import { AUDIT_ACTIONS, actorTypeOf, recordAudit } from "./audit";
import { isUniqueViolation, withTransaction, type Queryable, type ServiceContext } from "./context";
import { settingsOf } from "./graph";
import { fingerprintOf } from "./ids";

// ---------------------------------------------------------------------------
// Receipts

export type ConflictKind = ConflictRow["kind"];
export type ResolutionChoice = ConflictResolution["choice"];

/** The sheet is stored. `absorbed` means it matched what was already there. */
export interface ReceivedReceipt {
  status: "received";
  version: number;
  /** ISO 8601: when the tournament received this version. */
  receivedAt: string;
  /** True when nothing was written because the stored sheet already matched. */
  absorbed?: boolean;
  /** Set on a replay after the organiser settled two versions. */
  resolution?: ResolutionChoice;
}

/** The sheet was saved for the organiser as a second version. */
export interface ConflictReceipt {
  status: "conflict";
  kind: ConflictKind;
  conflictId: string;
  currentVersion: number;
}

/** What `receiveSheet` returns and what `submissions.response` stores. */
export type Receipt = ReceivedReceipt | ConflictReceipt;

/** The HTTP status a route handler sends for a receipt. */
export function httpStatusOf(receipt: Receipt): 200 | 409 {
  return receipt.status === "received" ? 200 : 409;
}

/** What the organiser's three doors return. */
export interface SheetWriteResult {
  assignmentId: string;
  version: number;
  /** ISO 8601. */
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// Shared guards and reads (also used by conflicts, waivers and overrides)

/** One judge's slot with everything a write needs to check. */
export interface SheetSlot {
  assignment: AssignmentRow;
  division: DivisionRow;
  judge: JudgeRow;
  tournament: TournamentRow;
}

export interface LoadSlotOptions {
  /** Take `FOR SHARE` on the assignment and division rows (Postgres only). */
  lock?: boolean;
  /** Return a retired assignment instead of throwing `assignment_retired`. */
  allowRetired?: boolean;
  for?: "judge" | "organiser";
}

/**
 * Loads a sheet's slot: the assignment, its division (through the debate,
 * which is the source of truth for the division code), the judge and the
 * tournament. Throws `not_found` for an unknown id and, unless allowed,
 * `assignment_retired` with the successor's details for a retired one, so a
 * judge with a stale id learns it is stale rather than missing.
 *
 * With `lock`, on Postgres the assignment and division rows are share-locked
 * for the rest of the transaction: a concurrent publish (`FOR UPDATE` on the
 * division) waits for this write, and this write waits for it. PGlite has a
 * single connection, so no lock is needed there.
 */
export async function loadSheetSlot(
  tx: Tx,
  tournamentId: string,
  assignmentId: string,
  options: LoadSlotOptions = {},
): Promise<SheetSlot> {
  const query = tx
    .select({
      assignment: assignments,
      division: divisions,
      judge: judges,
      tournament: tournaments,
    })
    .from(assignments)
    .innerJoin(debates, eq(debates.id, assignments.debateId))
    .innerJoin(
      divisions,
      and(
        eq(divisions.tournamentId, debates.tournamentId),
        eq(divisions.code, debates.divisionCode),
      ),
    )
    .innerJoin(judges, eq(judges.id, assignments.judgeId))
    .innerJoin(tournaments, eq(tournaments.id, assignments.tournamentId))
    .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, assignmentId)))
    .$dynamic();
  const locked = options.lock && getDbDriver() === "pg";
  const [row] = await (locked ? query.for("share", { of: [assignments, divisions] }) : query);
  if (!row) throw errors.notFound("That sheet");
  if (row.assignment.retiredAt !== null && !options.allowRetired) {
    const details = await retirementDetails(tx, row.assignment);
    if (options.for === "organiser") {
      throw new AppError({
        code: "assignment_retired",
        status: 409,
        message: `The draw changed; this sheet belongs to the old draw. Use the new sheet for ${row.judge.name} in ${row.assignment.display.roomName}.`,
        details,
      });
    }
    throw errors.assignmentRetired(details);
  }
  return row;
}

/**
 * The facts a judge's phone needs about a retired sheet: when and why the
 * draw changed, which sheet replaced it, and whether the same four debaters
 * are on the new one (then the scores can be carried over).
 */
async function retirementDetails(tx: Queryable, retired: AssignmentRow) {
  const successor = retired.successorId
    ? (
        await tx
          .select()
          .from(assignments)
          .where(
            and(
              eq(assignments.tournamentId, retired.tournamentId),
              eq(assignments.id, retired.successorId),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  return {
    assignmentId: retired.id,
    retiredAt: retired.retiredAt?.toISOString() ?? null,
    retiredReason: retired.retiredReason,
    successorId: retired.successorId,
    successorDisplay: successor?.display ?? null,
    speakersUnchanged:
      successor !== undefined &&
      canonicalJson(retired.identity.speakers) === canonicalJson(successor.identity.speakers),
  };
}

/** Throws `division_finalized` (423) when the division's results are published. */
export function refuseWhenPublished(
  division: DivisionRow,
  audience: "judge" | "organiser" = "judge",
): void {
  if (division.finalizedAt === null) return;
  if (audience === "organiser") {
    throw new AppError({
      code: "division_finalized",
      status: 423,
      message: `Results for ${division.code} are published. Reopen them first.`,
      details: { divisionCode: division.code, finalizedAt: division.finalizedAt.toISOString() },
    });
  }
  throw errors.divisionFinalized({
    divisionCode: division.code,
    finalizedAt: division.finalizedAt.toISOString(),
  });
}

/**
 * Validates a payload against the tournament's rubric and the exact debaters
 * of the slot. The route handler has already checked the envelope; this is
 * the check that a sheet means what the draw says it should.
 */
export function validatePayload(raw: unknown, slot: SheetSlot): SheetPayload {
  const { identity } = slot.assignment;
  const parsed = parseSheetPayload(raw, {
    rubric: settingsOf(slot.tournament).rubric,
    speakerIds: identity.speakers.map((speaker) => speaker.id),
    teamIds: [identity.governmentTeamId, identity.oppositionTeamId],
  });
  if (parsed.ok) return parsed.data;
  throw errors.validation("Some of the scores on this sheet are not valid.", {
    issues: parsed.errors,
  });
}

/** The sheet's current version, or version 0 when nothing has been received. */
export type CurrentSheet = { version: 0; row: null } | { version: number; row: SheetVersionRow };

export async function readCurrentSheet(
  db: Queryable,
  tournamentId: string,
  assignmentId: string,
): Promise<CurrentSheet> {
  const [row] = await db
    .select({ version: sheetVersions })
    .from(sheets)
    .innerJoin(sheetVersions, eq(sheetVersions.id, sheets.currentVersionId))
    .where(and(eq(sheets.tournamentId, tournamentId), eq(sheets.assignmentId, assignmentId)))
    .limit(1);
  if (!row) return { version: 0, row: null };
  return { version: row.version.version, row: row.version };
}

/** The payload a stored version holds. */
export function payloadOf(row: SheetVersionRow): SheetPayload {
  return { scores: row.scores, sideFlipped: row.sideFlipped, roleSwaps: row.roleSwaps };
}

/**
 * The 409 an organiser sees when the sheet changed under them. The judge's
 * `version_conflict` message talks about two versions; an organiser just
 * needs to reload.
 */
export function organiserStale(currentVersion: number): AppError {
  return new AppError({
    code: "version_conflict",
    status: 409,
    message: "This sheet changed since the page was loaded. Reload and try again.",
    details: { currentVersion },
  });
}

// ---------------------------------------------------------------------------
// The one write

export interface VersionWrite {
  tournamentId: string;
  assignmentId: string;
  /** The version the writer read. The write only lands if it is still current. */
  expectedVersion: number;
  payload: SheetPayload;
  source: SheetVersionRow["source"];
  actor: { type: SheetVersionRow["actorType"]; id: string; name: string };
  reason?: string | null;
  requestKey?: string | null;
  receivedAt: Date;
}

/** Thrown inside the savepoint when the compare-and-set moved zero rows. */
class WriteLost extends Error {
  constructor() {
    super("another write reached the sheet first");
    this.name = "WriteLost";
  }
}

/**
 * Appends a version and moves the sheet's pointer to it, or returns `null`
 * when another write got there first.
 *
 * The two statements run inside a savepoint. A concurrent writer shows up in
 * one of two ways: the version number is already taken (a unique violation on
 * `sheet_versions`, which on Postgres blocks until the other transaction
 * commits and then fails) or the pointer's `WHERE version = expected` moves
 * zero rows. Either way the savepoint is rolled back and the caller decides
 * what the loss means; the outer transaction stays usable.
 */
export async function writeSheetVersion(
  tx: Tx,
  write: VersionWrite,
): Promise<SheetVersionRow | null> {
  try {
    return await tx.transaction(async (sp) => {
      const [version] = await sp
        .insert(sheetVersions)
        .values({
          tournamentId: write.tournamentId,
          assignmentId: write.assignmentId,
          version: write.expectedVersion + 1,
          scores: write.payload.scores,
          sideFlipped: write.payload.sideFlipped,
          roleSwaps: write.payload.roleSwaps,
          source: write.source,
          actorType: write.actor.type,
          actorId: write.actor.id,
          actorName: write.actor.name,
          reason: write.reason ?? null,
          requestKey: write.requestKey ?? null,
          receivedAt: write.receivedAt,
        })
        .returning();
      const moved = await sp
        .insert(sheets)
        .values({
          tournamentId: write.tournamentId,
          assignmentId: write.assignmentId,
          version: version.version,
          currentVersionId: version.id,
          updatedAt: write.receivedAt,
        })
        .onConflictDoUpdate({
          target: [sheets.tournamentId, sheets.assignmentId],
          set: {
            version: version.version,
            currentVersionId: version.id,
            updatedAt: write.receivedAt,
          },
          setWhere: eq(sheets.version, write.expectedVersion),
        })
        .returning({ version: sheets.version });
      if (moved.length === 0) throw new WriteLost();
      return version;
    });
  } catch (error) {
    if (error instanceof WriteLost || isUniqueViolation(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Judge submissions

export interface ReceiveSheetInput {
  tournamentId: string;
  /** The judge of the session. Must own the assignment. */
  judgeId: string;
  assignmentId: string;
  /** The phone's id for this submission; the same id always gets the same answer. */
  requestId: string;
  /** The sheet version the judge started from; 0 for a first submission. */
  baseVersion: number;
  payload: SheetPayload;
  /** The judge app's build, for the log only. */
  clientVersion?: string;
}

/** Same rule as `request-id.ts`: plain identifiers only, so an id is safe in logs and keys. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;

/**
 * Receives a judge's sheet. One transaction; see the file comment for the
 * idea and the plan's submit algorithm for the statement-by-statement shape.
 *
 * Throws: `forbidden` (403) for another judge's sheet, `assignment_retired`
 * (409, with successor details) when the draw changed, `division_finalized`
 * (423) once results are published, `request_reused` (409) for a known
 * request id with different content, `validation` (400) for a sheet that
 * does not fit the rubric or the debate.
 */
export async function receiveSheet(
  ctx: ServiceContext,
  input: ReceiveSheetInput,
): Promise<Receipt> {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw errors.validation("The request id is not valid.", {
      issues: [{ path: "requestId", message: "Use letters, digits, dots, dashes and colons." }],
    });
  }
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    throw errors.validation("The base version is not valid.", {
      issues: [{ path: "baseVersion", message: "Must be a whole number, 0 or more." }],
    });
  }
  const fingerprint = fingerprintOf([input.assignmentId, input.baseVersion, input.payload]);

  return withTransaction(ctx, async (tx) => {
    const claim = await claimReceipt(tx, input, fingerprint);
    if (claim.replay) {
      ctx.log.info(
        { requestId: input.requestId, assignmentId: input.assignmentId },
        "Receipt replayed",
      );
      return claim.receipt;
    }

    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, { lock: true });
    if (slot.assignment.judgeId !== input.judgeId) {
      throw errors.forbidden("This sheet belongs to another judge.");
    }
    refuseWhenPublished(slot.division);
    const payload = validatePayload(input.payload, slot);
    const receivedAt = ctx.now();
    const current = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);

    const receipt =
      input.baseVersion === current.version
        ? await storeJudgeVersion(tx, ctx, input, slot, payload, current, receivedAt)
        : await settleMismatch(tx, ctx, input, slot, payload, current, receivedAt);

    await completeReceipt(tx, input, receipt, receivedAt);
    return receipt;
  });
}

type Claim = { replay: true; receipt: Receipt } | { replay: false };

/**
 * Step 1 of the submit algorithm: claim the request id. A fresh id gets a
 * pending row that the rest of the transaction completes (or rolls back
 * with it). A known id replays its stored answer when the content matches
 * and is refused when it does not.
 */
async function claimReceipt(tx: Tx, input: ReceiveSheetInput, fingerprint: string): Promise<Claim> {
  const claimed = await tx
    .insert(submissions)
    .values({
      tournamentId: input.tournamentId,
      judgeId: input.judgeId,
      requestId: input.requestId,
      assignmentId: input.assignmentId,
      fingerprint,
      state: "pending",
    })
    .onConflictDoNothing()
    .returning({ requestId: submissions.requestId });
  if (claimed.length > 0) return { replay: false };

  const [existing] = await tx
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.tournamentId, input.tournamentId),
        eq(submissions.judgeId, input.judgeId),
        eq(submissions.requestId, input.requestId),
      ),
    )
    .limit(1);
  if (!existing) {
    // The insert found a row that a select cannot see: not a state this
    // transaction can reason about, so let the phone try again.
    throw errors.dbUnavailable(new Error("submission receipt vanished between insert and select"));
  }
  if (existing.fingerprint !== fingerprint) {
    throw errors.requestReused({ requestId: input.requestId, assignmentId: existing.assignmentId });
  }
  if (existing.state !== "done" || existing.response === null) {
    // A pending receipt is never committed on its own, so this means an
    // interrupted transaction left a half-written row: not something a
    // retry can fix by itself.
    throw errors.internal(new Error(`submission ${input.requestId} is pending after commit`));
  }
  return { replay: true, receipt: existing.response as unknown as Receipt };
}

/** Step 5, first branch: the judge built on the current version, so the sheet is stored. */
async function storeJudgeVersion(
  tx: Tx,
  ctx: ServiceContext,
  input: ReceiveSheetInput,
  slot: SheetSlot,
  payload: SheetPayload,
  current: CurrentSheet,
  receivedAt: Date,
): Promise<Receipt> {
  const version = await writeSheetVersion(tx, {
    tournamentId: input.tournamentId,
    assignmentId: input.assignmentId,
    expectedVersion: current.version,
    payload,
    source: "judge",
    actor: { type: "judge", id: slot.judge.id, name: slot.judge.name },
    requestKey: requestKeyOf(input.judgeId, input.requestId),
    receivedAt,
  });
  if (version === null) {
    // Another write landed between our read and our write. Re-read and treat
    // the submission as built on an older version, which it now is.
    const latest = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);
    if (latest.row === null) {
      throw errors.internal(
        new Error(`sheet ${input.assignmentId} lost a version write without a current pointer`),
      );
    }
    return settleMismatch(tx, ctx, input, slot, payload, latest, receivedAt);
  }
  await recordAudit(tx, ctx, {
    tournamentId: input.tournamentId,
    action: AUDIT_ACTIONS.sheetReceived,
    entityType: "sheet",
    entityId: input.assignmentId,
    assignmentId: input.assignmentId,
    divisionCode: slot.division.code,
    before: current.row ? versionSummary(current.row) : null,
    after: versionSummary(version),
  });
  return { status: "received", version: version.version, receivedAt: receivedAt.toISOString() };
}

/**
 * Step 5, the other branches: the judge built on an older version.
 *
 * - The same content as the stored sheet is absorbed: nothing to decide,
 *   the phone gets a 200 and stops retrying. This is the normal end of a
 *   paper type-in followed by the phone coming back online.
 * - The same numbers and sides with different comments is a light conflict
 *   the organiser settles with one tap ("add the comments").
 * - Anything else is two versions of the sheet.
 * - No stored sheet at all (the phone remembers a version the tournament
 *   does not, for instance after a restore) is stored as version 1: a
 *   sheet is more useful than a conflict with nothing to compare against.
 */
async function settleMismatch(
  tx: Tx,
  ctx: ServiceContext,
  input: ReceiveSheetInput,
  slot: SheetSlot,
  payload: SheetPayload,
  current: CurrentSheet,
  receivedAt: Date,
): Promise<Receipt> {
  if (current.row === null) {
    return storeJudgeVersion(tx, ctx, input, slot, payload, current, receivedAt);
  }
  const stored = payloadOf(current.row);
  if (samePayload(payload, stored)) {
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.sheetDuplicateAbsorbed,
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      after: {
        version: current.version,
        requestId: input.requestId,
        baseVersion: input.baseVersion,
      },
    });
    return {
      status: "received",
      version: current.version,
      receivedAt: current.row.receivedAt.toISOString(),
      absorbed: true,
    };
  }
  const kind: ConflictKind = sameNumbersAndSides(payload, stored) ? "comments_only" : "version";
  const [conflict] = await tx
    .insert(conflicts)
    .values({
      tournamentId: input.tournamentId,
      assignmentId: input.assignmentId,
      judgeId: input.judgeId,
      requestId: input.requestId,
      kind,
      incoming: payload,
      baseVersion: input.baseVersion,
      currentVersion: current.version,
      status: "open",
      createdAt: receivedAt,
    })
    .returning();
  ctx.log.info(
    { assignmentId: input.assignmentId, conflictId: conflict.id, kind },
    "Sheet stored as a second version for the organiser",
  );
  return { status: "conflict", kind, conflictId: conflict.id, currentVersion: current.version };
}

/** Step 6: the receipt becomes the durable answer for this request id. */
async function completeReceipt(
  tx: Tx,
  input: ReceiveSheetInput,
  receipt: Receipt,
  completedAt: Date,
): Promise<void> {
  await tx
    .update(submissions)
    .set({
      state: "done",
      httpStatus: httpStatusOf(receipt),
      response: receipt as unknown as StoredResponse,
      completedAt,
    })
    .where(
      and(
        eq(submissions.tournamentId, input.tournamentId),
        eq(submissions.judgeId, input.judgeId),
        eq(submissions.requestId, input.requestId),
      ),
    );
}

/** `sheet_versions.request_key` and `submissions` share this key shape. */
export function requestKeyOf(judgeId: string, requestId: string): string {
  return `${judgeId}:${requestId}`;
}

/** The small before/after the audit row keeps; the scores live in `sheet_versions`. */
export function versionSummary(row: SheetVersionRow) {
  return { version: row.version, source: row.source, actorName: row.actorName };
}

/** True when every field of both payloads matches, comments included. */
export function samePayload(a: SheetPayload, b: SheetPayload): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** True when the numbers, the sides and the role swaps match; comments may differ. */
export function sameNumbersAndSides(a: SheetPayload, b: SheetPayload): boolean {
  return (
    canonicalJson(numbersOf(a.scores)) === canonicalJson(numbersOf(b.scores)) &&
    a.sideFlipped === b.sideFlipped &&
    canonicalJson(a.roleSwaps) === canonicalJson(b.roleSwaps)
  );
}

function numbersOf(scores: SheetScores) {
  const numbers: Record<string, Record<string, number>> = {};
  for (const [speakerId, score] of Object.entries(scores)) {
    numbers[speakerId] = {
      argumentation: score.argumentation,
      rebuttal: score.rebuttal,
      presentation: score.presentation,
      poi: score.poi,
      overall: score.overall,
    };
  }
  return numbers;
}

// ---------------------------------------------------------------------------
// Organiser entry

export interface EnterPaperSheetInput {
  tournamentId: string;
  assignmentId: string;
  payload: SheetPayload;
  reason: string;
  /** The organiser has checked the judge's name on the paper against the slot. */
  judgeNameConfirmed: boolean;
}

/**
 * Types in a paper sheet as version 1. Refused when a sheet has already
 * been received (use `correctSheet`), when the slot is retired or when the
 * division is published. The reason is mandatory and goes in the history.
 */
export async function enterPaperSheet(
  ctx: ServiceContext,
  input: EnterPaperSheetInput,
): Promise<SheetWriteResult> {
  if (input.judgeNameConfirmed !== true) {
    throw errors.validation("Confirm the judge's name on the paper sheet before typing it in.", {
      issues: [{ path: "judgeNameConfirmed", message: "Tick the box to confirm the judge." }],
    });
  }
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, {
      lock: true,
      for: "organiser",
    });
    refuseWhenPublished(slot.division, "organiser");
    const payload = validatePayload(input.payload, slot);
    const current = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);
    if (current.row !== null) throw alreadyReceived(slot, current.version);

    const receivedAt = ctx.now();
    const version = await writeSheetVersion(tx, {
      tournamentId: input.tournamentId,
      assignmentId: input.assignmentId,
      expectedVersion: 0,
      payload,
      source: "organiser_paper",
      actor: actorOf(ctx),
      reason: input.reason,
      receivedAt,
    });
    if (version === null) throw alreadyReceived(slot, current.version + 1);

    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.sheetPaperEntered,
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      after: versionSummary(version),
    });
    return {
      assignmentId: input.assignmentId,
      version: version.version,
      receivedAt: receivedAt.toISOString(),
    };
  });
}

export interface CorrectSheetInput {
  tournamentId: string;
  assignmentId: string;
  /** The version shown on the organiser's screen. */
  baseVersion: number;
  payload: SheetPayload;
  reason: string;
}

/**
 * Changes a received sheet. The organiser's screen names the version it
 * showed; if the sheet moved on since, the correction is refused with
 * `version_conflict` and the organiser reloads. Every correction is a new
 * version with a reason; the old one stays in the history.
 */
export async function correctSheet(
  ctx: ServiceContext,
  input: CorrectSheetInput,
): Promise<SheetWriteResult> {
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, {
      lock: true,
      for: "organiser",
    });
    refuseWhenPublished(slot.division, "organiser");
    const payload = validatePayload(input.payload, slot);
    const current = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);
    if (current.row === null) {
      throw errors.validation(
        "No sheet has been received for this judge yet. Type it in from paper instead.",
      );
    }
    if (input.baseVersion !== current.version) throw organiserStale(current.version);

    const receivedAt = ctx.now();
    const version = await writeSheetVersion(tx, {
      tournamentId: input.tournamentId,
      assignmentId: input.assignmentId,
      expectedVersion: current.version,
      payload,
      source: "organiser_correction",
      actor: actorOf(ctx),
      reason: input.reason,
      receivedAt,
    });
    if (version === null) throw organiserStale(current.version + 1);

    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.sheetCorrected,
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      before: versionSummary(current.row),
      after: versionSummary(version),
      diff: scoreDiff(current.row.scores, payload.scores),
    });
    return {
      assignmentId: input.assignmentId,
      version: version.version,
      receivedAt: receivedAt.toISOString(),
    };
  });
}

export interface EnterHandoffInput {
  tournamentId: string;
  assignmentId: string;
  /** The judge whose phone could not send; must own the assignment. */
  judgeId: string;
  /** The request id the phone shows in its hand-off code. */
  requestId: string;
  payload: SheetPayload;
  reason: string;
}

export interface HandoffResult extends SheetWriteResult {
  /**
   * Always false: the phone's retry settles against the stored sheet by
   * content (see `enterHandoff`), never against a stored receipt.
   */
  receiptStored: false;
}

/**
 * Enters a sheet the judge handed to the organiser (QR or read-out code)
 * because the phone could not send it. Stored as version 1 with source
 * `judge_handoff`; the version's actor is the organiser who typed it, the
 * request key ties it to the phone's submission.
 *
 * No receipt is stored for the phone's request id. The hand-off code
 * carries the numbers and sides but rarely the comments, so the organiser's
 * payload is not the payload the phone will send. A stored 200 would make
 * the phone stop and lose the judge's comments; a stored fingerprint over the
 * organiser's payload would refuse the phone with `request_reused`. Instead
 * the phone's retry goes through `receiveSheet` as a submission built on
 * version 0: identical content is absorbed, different comments become a
 * comments-only case the organiser settles with one tap (the panel's
 * identical-numbers rule).
 */
export async function enterHandoff(
  ctx: ServiceContext,
  input: EnterHandoffInput,
): Promise<HandoffResult> {
  requireReason(input.reason);
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw errors.validation("The hand-off code's request id is not valid.");
  }
  return withTransaction(ctx, async (tx) => {
    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, {
      lock: true,
      for: "organiser",
    });
    if (slot.assignment.judgeId !== input.judgeId) {
      throw errors.validation("This hand-off code is for another judge's sheet.");
    }
    refuseWhenPublished(slot.division, "organiser");
    const payload = validatePayload(input.payload, slot);
    const current = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);
    if (current.row !== null) throw alreadyReceived(slot, current.version);

    const receivedAt = ctx.now();
    const version = await writeSheetVersion(tx, {
      tournamentId: input.tournamentId,
      assignmentId: input.assignmentId,
      expectedVersion: 0,
      payload,
      source: "judge_handoff",
      actor: actorOf(ctx),
      reason: input.reason,
      requestKey: requestKeyOf(input.judgeId, input.requestId),
      receivedAt,
    });
    if (version === null) throw alreadyReceived(slot, 1);

    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.judgeHandoffEntered,
      entityType: "sheet",
      entityId: input.assignmentId,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      after: { ...versionSummary(version), requestId: input.requestId, receiptStored: false },
    });
    return {
      assignmentId: input.assignmentId,
      version: version.version,
      receivedAt: receivedAt.toISOString(),
      receiptStored: false,
    };
  });
}

/** The version actor for an organiser's write: whoever the context says is acting. */
function actorOf(ctx: ServiceContext): VersionWrite["actor"] {
  return { type: actorTypeOf(ctx.actor), id: ctx.actor.id, name: ctx.actor.name };
}

function requireReason(reason: string): void {
  if (typeof reason === "string" && reason.trim().length > 0) return;
  throw errors.validation("Give a reason for this change. It is kept in the history.", {
    issues: [{ path: "reason", message: "A reason is required." }],
  });
}

function alreadyReceived(slot: SheetSlot, currentVersion: number): AppError {
  return errors.validation(
    `A sheet from ${slot.judge.name} has already been received. Use "Correct scores" to change it.`,
    { currentVersion },
  );
}

/** The fields of one debater's marks, in sheet order. */
const SCORE_KEYS = [
  "argumentation",
  "rebuttal",
  "presentation",
  "poi",
  "overall",
  "www",
  "ebi",
] as const;

/** One entry per changed number or comment, small enough for the history page. */
function scoreDiff(before: SheetScores, after: SheetScores) {
  const changes: { speakerId: string; field: string; from: unknown; to: unknown }[] = [];
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const speakerId of ids) {
    const was = before[speakerId];
    const now = after[speakerId];
    for (const field of SCORE_KEYS) {
      if (was?.[field] !== now?.[field]) {
        changes.push({ speakerId, field, from: was?.[field] ?? null, to: now?.[field] ?? null });
      }
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// History

export interface SheetHistory {
  /** Every version, oldest first. Empty when nothing has been received. */
  versions: SheetVersionRow[];
  /** Every two-versions case for the sheet, open and settled, oldest first. */
  conflicts: ConflictRow[];
  /** Every waiver, live and revoked, oldest first. */
  waivers: SheetWaiverRow[];
}

/** Everything that ever happened to one sheet, for the sheet drawer. */
export async function sheetHistory(
  db: Queryable,
  tournamentId: string,
  assignmentId: string,
): Promise<SheetHistory> {
  const [versions, conflictRows, waiverRows] = await Promise.all([
    db
      .select()
      .from(sheetVersions)
      .where(
        and(
          eq(sheetVersions.tournamentId, tournamentId),
          eq(sheetVersions.assignmentId, assignmentId),
        ),
      )
      .orderBy(asc(sheetVersions.version)),
    db
      .select()
      .from(conflicts)
      .where(
        and(eq(conflicts.tournamentId, tournamentId), eq(conflicts.assignmentId, assignmentId)),
      )
      .orderBy(asc(conflicts.createdAt), asc(conflicts.id)),
    db
      .select()
      .from(sheetWaivers)
      .where(
        and(
          eq(sheetWaivers.tournamentId, tournamentId),
          eq(sheetWaivers.assignmentId, assignmentId),
        ),
      )
      .orderBy(asc(sheetWaivers.createdAt), asc(sheetWaivers.id)),
  ]);
  return { versions, conflicts: conflictRows, waivers: waiverRows };
}
