/**
 * The scoring write path against an embedded Postgres: judge submissions
 * with receipts, two versions and how the organiser settles them, paper
 * entry, corrections, hand-offs, waivers, publishing and reopening, the
 * live board and the device heartbeat.
 *
 * The draw service is not available yet, so a local helper stores a draw
 * and derives the assignments straight from the domain (`identityOf`,
 * `displayOf`, `assignmentId`), the same way the draw service will.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { generateDraw } from "@/domain/draw";
import { simulateSheet } from "@/domain/sample";
import { assignmentId, displayOf, identityOf } from "@/domain/schedule";
import { WORKBOOK_POLICY } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Schedule, SheetPayload } from "@/domain/types";
import {
  assignments,
  auditLog,
  conflicts,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  rounds,
  sheets,
  sheetVersions,
  submissions,
  tournamentSnapshots,
  type AssignmentRow,
  type Db,
  type NewAssignmentRow,
  type Tx,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { fingerprintOf, loadGraph, toSchedule, type ServiceContext } from "@/server/services";
import { listOpenConflicts, resolveConflict } from "@/server/services/conflicts";
import { finalizeDivision, publishBlockers, reopenDivision } from "@/server/services/finalize";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { closeRound, openRound, reopenRound } from "@/server/services/rounds";
import { recordHeartbeat } from "@/server/services/heartbeat";
import { liveBoard } from "@/server/services/live";
import { addOverride, listOverrides, revokeOverride } from "@/server/services/overrides";
import { divisionResults } from "@/server/services/results";
import {
  correctSheet,
  enterHandoff,
  enterPaperSheet,
  receiveSheet,
  sheetHistory,
  writeSheetVersion,
  type Receipt,
} from "@/server/services/sheets";
import { unwaiveSheet, waiveSheet } from "@/server/services/waivers";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

// ---------------------------------------------------------------------------
// Seeding

interface Drawn {
  tournamentId: string;
  schedule: Schedule;
  /** Every live assignment, in debate then seat order. */
  assignments: AssignmentRow[];
}

/**
 * A small tournament (4 + 4 teams, 4 rooms, 3 judges per room) with a stored
 * draw and one live assignment per judge seat. Every seed uses fresh uuids,
 * so a file also runs against a shared Postgres.
 */
async function seedDrawn(db: Db, seed = "sheets"): Promise<Drawn> {
  const { tournamentId } = await seedTournament(db);
  await seedSample(db, tournamentId, { open: 4, novice: 4, rooms: 4, judgesPerRoom: 3, seed });
  const before = toSchedule(await loadGraph(db, tournamentId));
  const draw = generateDraw({
    schedule: before,
    divisionCodes: ["Open", "Novice"],
    seed: `2026-${seed.toUpperCase()}`,
    method: "random",
  });
  if (!draw.ok) throw new Error(draw.error.message);

  for (const debate of draw.debates) {
    const [row] = await db
      .insert(debates)
      .values({
        tournamentId,
        divisionCode: debate.divisionCode,
        round: debate.round,
        roomId: debate.roomId,
        governmentTeamId: debate.governmentTeamId,
        oppositionTeamId: debate.oppositionTeamId,
        motion: debate.motion,
      })
      .returning();
    await db.insert(debateTeams).values([
      {
        tournamentId,
        debateId: row.id,
        round: debate.round,
        teamId: debate.governmentTeamId,
        side: "government",
      },
      {
        tournamentId,
        debateId: row.id,
        round: debate.round,
        teamId: debate.oppositionTeamId,
        side: "opposition",
      },
    ]);
    await db.insert(debateJudges).values(
      debate.judgeIds.map((judgeId, index) => ({
        tournamentId,
        debateId: row.id,
        round: debate.round,
        judgeId,
        seat: index + 1,
      })),
    );
  }

  const schedule = toSchedule(await loadGraph(db, tournamentId));
  const rows: NewAssignmentRow[] = [];
  for (const debate of schedule.debates) {
    for (const judgeId of debate.judgeIds) {
      const identity = identityOf(schedule, debate, judgeId);
      rows.push({
        tournamentId,
        id: assignmentId(identity, [], schedule.revision),
        debateId: debate.id,
        judgeId,
        identity,
        identityHash: fingerprintOf(identity),
        display: displayOf(schedule, debate, judgeId),
        scheduleRevision: schedule.revision,
      });
    }
  }
  const inserted = await db.insert(assignments).values(rows).returning();
  const order = new Map(rows.map((row, index) => [row.id, index]));
  inserted.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { tournamentId, schedule, assignments: inserted };
}

/** The live assignments of one division and round. */
function seatsIn(drawn: Drawn, divisionCode: string, round: number): AssignmentRow[] {
  return drawn.assignments.filter(
    (a) => a.identity.divisionCode === divisionCode && a.identity.round === round,
  );
}

/** A plausible sheet for an assignment, with no rogue score. */
function sheetFor(assignment: AssignmentRow, seed = "sheets"): SheetPayload {
  return simulateSheet({
    seed,
    assignmentDisplay: assignment.display,
    rubric: DEFAULT_SETTINGS.rubric,
    judgeId: assignment.judgeId,
    rogueChance: 0,
  });
}

/** The same sheet with one debater's Overall moved by `delta`. */
function withOverall(payload: SheetPayload, speakerId: string, delta: number): SheetPayload {
  const score = payload.scores[speakerId];
  return {
    ...payload,
    scores: { ...payload.scores, [speakerId]: { ...score, overall: score.overall + delta } },
  };
}

/** The same sheet with one debater's "What went well" replaced. */
function withComment(payload: SheetPayload, speakerId: string, www: string): SheetPayload {
  const score = payload.scores[speakerId];
  return { ...payload, scores: { ...payload.scores, [speakerId]: { ...score, www } } };
}

interface SubmitOptions {
  requestId?: string;
  baseVersion?: number;
  payload?: SheetPayload;
}

/** A judge submission for an assignment. */
function submit(
  ctx: ServiceContext,
  drawn: Drawn,
  assignment: AssignmentRow,
  options: SubmitOptions = {},
): Promise<Receipt> {
  return receiveSheet(ctx, {
    tournamentId: drawn.tournamentId,
    judgeId: assignment.judgeId,
    assignmentId: assignment.id,
    requestId: options.requestId ?? `req-${randomUUID()}`,
    baseVersion: options.baseVersion ?? 0,
    payload: options.payload ?? sheetFor(assignment),
  });
}

/** Runs `work` and returns whatever it threw. */
async function caught(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function auditActions(db: Db, tournamentId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tournamentId, tournamentId))
    .orderBy(asc(auditLog.id));
  return rows.map((row) => row.action);
}

async function versionsOf(db: Db, tournamentId: string, assignmentId: string) {
  return (await sheetHistory(db, tournamentId, assignmentId)).versions;
}

/** Retires an assignment and stores a successor with the same matchup. */
async function retire(db: Db, drawn: Drawn, assignment: AssignmentRow): Promise<AssignmentRow> {
  const successorId = assignmentId(assignment.identity, [assignment.id], 1);
  await db
    .update(assignments)
    .set({ retiredAt: new Date(), retiredReason: "the draw changed", successorId })
    .where(
      and(eq(assignments.tournamentId, drawn.tournamentId), eq(assignments.id, assignment.id)),
    );
  const [successor] = await db
    .insert(assignments)
    .values({
      tournamentId: drawn.tournamentId,
      id: successorId,
      debateId: assignment.debateId,
      judgeId: assignment.judgeId,
      identity: assignment.identity,
      identityHash: assignment.identityHash,
      display: assignment.display,
      scheduleRevision: 1,
    })
    .returning();
  return successor;
}

// ---------------------------------------------------------------------------
// Judge submissions

describe("receiveSheet", () => {
  it("stores a first submission as version 1 with a receipt and an audit row", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const at = new Date("2026-09-16T11:04:00.000Z");
    const ctx = testContext(db, { now: () => at });
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);

    const receipt = await submit(ctx, drawn, seat, { requestId: "req-first", payload });
    expect(receipt).toEqual({ status: "received", version: 1, receivedAt: at.toISOString() });

    const [sheet] = await db
      .select()
      .from(sheets)
      .where(and(eq(sheets.tournamentId, drawn.tournamentId), eq(sheets.assignmentId, seat.id)));
    expect(sheet.version).toBe(1);
    const [version] = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(version).toMatchObject({
      version: 1,
      scores: payload.scores,
      source: "judge",
      actorType: "judge",
      actorId: seat.judgeId,
      actorName: seat.display.judgeName,
      requestKey: `${seat.judgeId}:req-first`,
    });
    expect(version.id).toBe(sheet.currentVersionId);

    const [submission] = await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.tournamentId, drawn.tournamentId),
          eq(submissions.requestId, "req-first"),
        ),
      );
    expect(submission).toMatchObject({ state: "done", httpStatus: 200, response: receipt });
    expect(submission.fingerprint).toBe(fingerprintOf([seat.id, 0, payload]));
    expect(await auditActions(db, drawn.tournamentId)).toEqual(["sheet.received"]);
  });

  it("replays the stored receipt for the same request id and refuses a different payload", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);

    const first = await submit(ctx, drawn, seat, { requestId: "req-same", payload });
    const again = await receiveSheet(
      testContext(db, { now: () => new Date("2030-01-01T00:00:00.000Z") }),
      {
        tournamentId: drawn.tournamentId,
        judgeId: seat.judgeId,
        assignmentId: seat.id,
        requestId: "req-same",
        baseVersion: 0,
        payload,
      },
    );
    expect(again).toEqual(first);
    expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);

    const speakerId = seat.identity.speakers[0].id;
    const reused = await caught(
      submit(ctx, drawn, seat, {
        requestId: "req-same",
        payload: withOverall(payload, speakerId, -1),
      }),
    );
    expect(reused).toMatchObject({ code: "request_reused", status: 409 });
    expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);
  });

  it("lets two different judges on the same debate both be received", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [first, second] = seatsIn(drawn, "Open", 1);
    expect(first.debateId).toBe(second.debateId);
    expect(first.judgeId).not.toBe(second.judgeId);

    const [a, b] = await Promise.all([submit(ctx, drawn, first), submit(ctx, drawn, second)]);
    expect(a).toMatchObject({ status: "received", version: 1 });
    expect(b).toMatchObject({ status: "received", version: 1 });
  });

  it("refuses another judge's sheet, a bad request id and a sheet that does not fit the debate", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat, other] = seatsIn(drawn, "Open", 1);

    const forbidden = await caught(
      receiveSheet(ctx, {
        tournamentId: drawn.tournamentId,
        judgeId: other.judgeId,
        assignmentId: seat.id,
        requestId: "req-x",
        baseVersion: 0,
        payload: sheetFor(seat),
      }),
    );
    expect(forbidden).toMatchObject({ code: "forbidden", status: 403 });

    const badId = await caught(submit(ctx, drawn, seat, { requestId: "has space" }));
    expect(badId).toMatchObject({ code: "validation" });

    // Both judges score the same four debaters, so a sheet for the other
    // seat fits; a sheet for another room does not.
    const sameRoom = await submit(ctx, drawn, seat, { payload: sheetFor(other) });
    expect(sameRoom).toMatchObject({ status: "received" });
    const elsewhere = seatsIn(drawn, "Novice", 1)[0];
    const misfit = await caught(submit(ctx, drawn, elsewhere, { payload: sheetFor(seat) }));
    expect(misfit).toMatchObject({ code: "validation", status: 400 });
    expect(
      (misfit as { details?: { issues?: unknown[] } }).details?.issues?.length,
    ).toBeGreaterThan(0);
    expect(await versionsOf(db, drawn.tournamentId, elsewhere.id)).toHaveLength(0);
  });

  it("keeps multibyte comments exactly as sent", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    const speakerId = seat.identity.speakers[1].id;
    const www = "Très bien — “great” rebuttal 👍 with a naïve façade";
    const payload = withComment(sheetFor(seat), speakerId, www);
    payload.scores[speakerId].ebi = "日本語のコメント · emoji 🎤🔥 · ‘curly’";

    await submit(ctx, drawn, seat, { requestId: "req-utf8", payload });
    const [version] = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(version.scores[speakerId].www).toBe(www);
    expect(version.scores[speakerId].ebi).toBe("日本語のコメント · emoji 🎤🔥 · ‘curly’");
    const replay = await submit(ctx, drawn, seat, { requestId: "req-utf8", payload });
    expect(replay).toMatchObject({ status: "received", version: 1 });
  });
});

describe("two versions", () => {
  it("records a stale submission as two versions; using the incoming one rewrites the receipt", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { actor: { type: "user", id: "org-1", name: "Sam Organiser" } });
    const [seat] = seatsIn(drawn, "Open", 1);
    const speakerId = seat.identity.speakers[0].id;
    const first = sheetFor(seat);
    const incoming = withOverall(first, speakerId, -5);

    await submit(ctx, drawn, seat, { requestId: "req-1", payload: first });
    const receipt = await submit(ctx, drawn, seat, {
      requestId: "req-2",
      payload: incoming,
      baseVersion: 0,
    });
    expect(receipt).toMatchObject({ status: "conflict", kind: "version", currentVersion: 1 });
    if (receipt.status !== "conflict") return;

    const open = await listOpenConflicts(db, drawn.tournamentId, "Open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      conflict: {
        id: receipt.conflictId,
        kind: "version",
        baseVersion: 0,
        currentVersion: 1,
        status: "open",
      },
      judgeName: seat.display.judgeName,
      round: 1,
    });
    expect(open[0].current?.version).toBe(1);
    expect(await listOpenConflicts(db, drawn.tournamentId, "Novice")).toEqual([]);

    const resolved = await resolveConflict(ctx, {
      tournamentId: drawn.tournamentId,
      conflictId: receipt.conflictId,
      choice: "incoming",
      reason: "The judge corrected a slip of the pen.",
    });
    expect(resolved).toMatchObject({ choice: "incoming", version: 2 });

    const versions = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(versions.map((v) => v.source)).toEqual(["judge", "organiser_resolution"]);
    expect(versions[1].scores[speakerId].overall).toBe(first.scores[speakerId].overall - 5);
    expect(versions[1]).toMatchObject({
      actorType: "organiser",
      actorName: "Sam Organiser",
      reason: "The judge corrected a slip of the pen.",
      requestKey: `${seat.judgeId}:req-2`,
    });

    const [conflict] = await db
      .select()
      .from(conflicts)
      .where(eq(conflicts.id, receipt.conflictId));
    expect(conflict.status).toBe("resolved");
    expect(conflict.resolution).toMatchObject({
      choice: "incoming",
      resolvedBy: "Sam Organiser",
      resultingVersion: 2,
    });

    // The phone retries the same request and now converges.
    const replay = await submit(ctx, drawn, seat, {
      requestId: "req-2",
      payload: incoming,
      baseVersion: 0,
    });
    expect(replay).toEqual({
      status: "received",
      version: 2,
      receivedAt: resolved.receivedAt,
      resolution: "incoming",
    });
    expect(await auditActions(db, drawn.tournamentId)).toEqual([
      "sheet.received",
      "conflict.resolved",
    ]);

    const settledAgain = await caught(
      resolveConflict(testContext(db, { log: silentLogger }), {
        tournamentId: drawn.tournamentId,
        conflictId: receipt.conflictId,
        choice: "keep",
        reason: "Second thoughts.",
      }),
    );
    expect(settledAgain).toMatchObject({ code: "validation" });
  });

  it("keeping the current version still writes an audited version and needs a reason", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 2);
    const speakerId = seat.identity.speakers[2].id;
    const first = sheetFor(seat);

    await submit(ctx, drawn, seat, { payload: first });
    const receipt = await submit(ctx, drawn, seat, {
      requestId: "req-stale",
      payload: withOverall(first, speakerId, 7),
    });
    if (receipt.status !== "conflict") throw new Error("expected two versions");

    const blank = await caught(
      resolveConflict(ctx, {
        tournamentId: drawn.tournamentId,
        conflictId: receipt.conflictId,
        choice: "keep",
        reason: "  ",
      }),
    );
    expect(blank).toMatchObject({ code: "validation" });

    await resolveConflict(ctx, {
      tournamentId: drawn.tournamentId,
      conflictId: receipt.conflictId,
      choice: "keep",
      reason: "The first sheet matched the paper copy.",
    });
    const versions = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(versions).toHaveLength(2);
    expect(versions[1].scores).toEqual(first.scores);
    expect(versions[1].source).toBe("organiser_resolution");
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tournamentId, drawn.tournamentId),
          eq(auditLog.action, "conflict.resolved"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe("The first sheet matched the paper copy.");
    expect(audit[0].after).toMatchObject({ choice: "keep", version: 2 });

    const replay = await submit(ctx, drawn, seat, {
      requestId: "req-stale",
      payload: withOverall(first, speakerId, 7),
    });
    expect(replay).toMatchObject({ status: "received", version: 2, resolution: "keep" });
  });

  it("treats a difference in the comments only as a light case that merging settles", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Novice", 1);
    const speakerId = seat.identity.speakers[3].id;
    const first = sheetFor(seat);
    const later = withComment(first, speakerId, "Added on the phone afterwards.");

    await submit(ctx, drawn, seat, { payload: first });
    const receipt = await submit(ctx, drawn, seat, { requestId: "req-comments", payload: later });
    expect(receipt).toMatchObject({ status: "conflict", kind: "comments_only", currentVersion: 1 });
    if (receipt.status !== "conflict") return;

    const merged = await resolveConflict(ctx, {
      tournamentId: drawn.tournamentId,
      conflictId: receipt.conflictId,
      choice: "merge_comments",
      reason: "Judge added feedback after sending.",
    });
    expect(merged.version).toBe(2);
    const [, version] = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(version.scores[speakerId].www).toBe("Added on the phone afterwards.");
    expect(version.scores[speakerId].overall).toBe(first.scores[speakerId].overall);
    for (const id of Object.keys(first.scores)) {
      if (id !== speakerId) expect(version.scores[id]).toEqual(first.scores[id]);
    }
    const replay = await submit(ctx, drawn, seat, { requestId: "req-comments", payload: later });
    expect(replay).toMatchObject({ status: "received", version: 2, resolution: "merge_comments" });
  });

  it("absorbs a resubmission whose content matches the stored sheet", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Novice", 2);
    const payload = sheetFor(seat);

    const first = await submit(ctx, drawn, seat, { payload });
    const again = await submit(ctx, drawn, seat, { requestId: "req-dup", payload, baseVersion: 0 });
    expect(again).toEqual({
      status: "received",
      version: 1,
      receivedAt: (first as { receivedAt: string }).receivedAt,
      absorbed: true,
    });
    expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);
    expect(await listOpenConflicts(db, drawn.tournamentId)).toEqual([]);
    expect(await auditActions(db, drawn.tournamentId)).toEqual([
      "sheet.received",
      "sheet.duplicate_absorbed",
    ]);
  });
});

describe("the draw and the published state", () => {
  it("refuses a retired sheet with the successor's details", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 3);
    const successor = await retire(db, drawn, seat);

    const error = await caught(submit(ctx, drawn, seat));
    expect(error).toMatchObject({
      code: "assignment_retired",
      status: 409,
      details: {
        assignmentId: seat.id,
        retiredReason: "the draw changed",
        successorId: successor.id,
        successorDisplay: successor.display,
        speakersUnchanged: true,
      },
    });
    expect(typeof (error as { details: { retiredAt: unknown } }).details.retiredAt).toBe("string");

    const moved = await submit(ctx, drawn, successor, { payload: sheetFor(seat) });
    expect(moved).toMatchObject({ status: "received", version: 1 });
  });

  it("refuses submissions, paper entry and waivers for a published division with 423", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat, other] = seatsIn(drawn, "Open", 1);
    const publishedAt = new Date("2026-09-16T17:00:00.000Z");
    await db
      .update(divisions)
      .set({ finalizedAt: publishedAt, finalizedBy: "Test runner" })
      .where(and(eq(divisions.tournamentId, drawn.tournamentId), eq(divisions.code, "Open")));

    const refused = await caught(submit(ctx, drawn, seat));
    expect(refused).toMatchObject({
      code: "division_finalized",
      status: 423,
      details: { divisionCode: "Open", finalizedAt: publishedAt.toISOString() },
    });
    const paper = await caught(
      enterPaperSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: other.id,
        payload: sheetFor(other),
        reason: "Phone died.",
        judgeNameConfirmed: true,
      }),
    );
    expect(paper).toMatchObject({ code: "division_finalized" });
    const waiver = await caught(
      waiveSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: other.id,
        reason: "Left early.",
      }),
    );
    expect(waiver).toMatchObject({ code: "division_finalized" });

    // The other division is untouched.
    const novice = seatsIn(drawn, "Novice", 1)[0];
    expect(await submit(ctx, drawn, novice)).toMatchObject({ status: "received" });
  });
});

// ---------------------------------------------------------------------------
// Organiser entry

describe("paper entry, corrections and hand-offs", () => {
  it("types in a paper sheet, then absorbs the judge's later identical submission", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);

    const unconfirmed = await caught(
      enterPaperSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        payload,
        reason: "Phone died in the room.",
        judgeNameConfirmed: false,
      }),
    );
    expect(unconfirmed).toMatchObject({ code: "validation" });

    const entered = await enterPaperSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      payload,
      reason: "Phone died in the room.",
      judgeNameConfirmed: true,
    });
    expect(entered).toMatchObject({ assignmentId: seat.id, version: 1 });
    const [version] = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(version).toMatchObject({
      source: "organiser_paper",
      actorType: "system",
      reason: "Phone died in the room.",
    });

    const late = await submit(ctx, drawn, seat, { payload, baseVersion: 0 });
    expect(late).toMatchObject({ status: "received", version: 1, absorbed: true });

    const speakerId = seat.identity.speakers[0].id;
    const withFeedback = await submit(ctx, drawn, seat, {
      payload: withComment(payload, speakerId, "Feedback the paper did not carry."),
    });
    expect(withFeedback).toMatchObject({ status: "conflict", kind: "comments_only" });

    const twice = await caught(
      enterPaperSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        payload,
        reason: "Again.",
        judgeNameConfirmed: true,
      }),
    );
    expect(twice).toMatchObject({ code: "validation", details: { currentVersion: 1 } });
    expect((twice as Error).message).toContain("Correct scores");
  });

  it("corrects a sheet from the version on screen and refuses a stale one", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 2);
    const speakerId = seat.identity.speakers[1].id;
    const payload = sheetFor(seat);
    await submit(ctx, drawn, seat, { payload });
    const corrected = withOverall(payload, speakerId, 2);

    const nothingYet = await caught(
      correctSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seatsIn(drawn, "Open", 2)[1].id,
        baseVersion: 0,
        payload: corrected,
        reason: "Typo.",
      }),
    );
    expect(nothingYet).toMatchObject({ code: "validation" });

    const stale = await caught(
      correctSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        baseVersion: 0,
        payload: corrected,
        reason: "Typo.",
      }),
    );
    expect(stale).toMatchObject({
      code: "version_conflict",
      status: 409,
      details: { currentVersion: 1 },
    });

    const noReason = await caught(
      correctSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        baseVersion: 1,
        payload: corrected,
        reason: "",
      }),
    );
    expect(noReason).toMatchObject({ code: "validation" });

    const result = await correctSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      baseVersion: 1,
      payload: corrected,
      reason: "Judge wrote 8 for 6 on the paper; confirmed by phone.",
    });
    expect(result.version).toBe(2);
    const versions = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(versions.map((v) => v.source)).toEqual(["judge", "organiser_correction"]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tournamentId, drawn.tournamentId), eq(auditLog.action, "sheet.corrected")),
      );
    expect(audit.reason).toBe("Judge wrote 8 for 6 on the paper; confirmed by phone.");
    expect(audit.diff).toEqual([
      {
        speakerId,
        field: "overall",
        from: payload.scores[speakerId].overall,
        to: payload.scores[speakerId].overall + 2,
      },
    ]);
  });

  it("settles a hand-off by comparing the complete phone payload", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat, plain] = seatsIn(drawn, "Novice", 3);
    const payload = sheetFor(seat);

    const wrongJudge = await caught(
      enterHandoff(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        judgeId: plain.judgeId,
        requestId: "req-handoff",
        payload,
        reason: "Hand-off from device.",
      }),
    );
    expect(wrongJudge).toMatchObject({ code: "validation" });

    const entered = await enterHandoff(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      judgeId: seat.judgeId,
      requestId: "req-handoff",
      payload,
      reason: "Hand-off from device: no signal in Room 2.",
    });
    expect(entered).toMatchObject({ version: 1, receiptStored: false });
    const [version] = await versionsOf(db, drawn.tournamentId, seat.id);
    expect(version).toMatchObject({
      source: "judge_handoff",
      requestKey: `${seat.judgeId}:req-handoff`,
    });

    const retry = await submit(ctx, drawn, seat, {
      requestId: "req-handoff",
      payload,
      baseVersion: 0,
    });
    expect(retry).toEqual({
      status: "received",
      version: 1,
      receivedAt: entered.receivedAt,
      absorbed: true,
    });
    expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);
    expect(await auditActions(db, drawn.tournamentId)).toEqual([
      "judge.handoff_entered",
      "sheet.duplicate_absorbed",
    ]);

    // A spoken handoff settles through the same identical-numbers rule.
    const plainPayload = sheetFor(plain);
    const spoken = await enterHandoff(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: plain.id,
      judgeId: plain.judgeId,
      requestId: "req-spoken",
      payload: plainPayload,
      reason: "Read out over the phone.",
    });
    expect(spoken.receiptStored).toBe(false);
    const absorbed = await submit(ctx, drawn, plain, {
      requestId: "req-spoken",
      payload: plainPayload,
    });
    expect(absorbed).toMatchObject({ status: "received", version: 1, absorbed: true });
  });
});

describe("sheet reliability regressions", () => {
  it.each(["base-version", "qr-hash"])(
    "keeps phone comments after a numbers-only hand-off (%s)",
    async (code) => {
      const db = await getDb();
      const drawn = await seedDrawn(db);
      const ctx = testContext(db, { log: silentLogger });
      const [seat] = seatsIn(drawn, "Open", 1);
      const phone = withComment(
        sheetFor(seat),
        seat.identity.speakers[0].id,
        "Feedback kept from the phone.",
      );
      const numbersOnly = {
        ...phone,
        scores: Object.fromEntries(
          Object.entries(phone.scores).map(([id, score]) => [id, { ...score, www: "", ebi: "" }]),
        ),
      };
      // Extra legacy QR fields must never manufacture a receipt for partial content.
      const input = {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        judgeId: seat.judgeId,
        requestId: `handoff-${code}`,
        payload: numbersOnly,
        reason: "No signal.",
        ...(code === "base-version"
          ? { baseVersion: 0 }
          : { fingerprint: fingerprintOf([seat.id, 0, phone]) }),
      };
      await enterHandoff(ctx, input);
      const receipt = await submit(ctx, drawn, seat, {
        requestId: input.requestId,
        payload: phone,
      });
      expect(receipt).toMatchObject({
        status: "conflict",
        kind: "comments_only",
        currentVersion: 1,
      });
      if (receipt.status !== "conflict")
        throw new Error("Expected comments to be held for merging");
      await resolveConflict(ctx, {
        tournamentId: drawn.tournamentId,
        conflictId: receipt.conflictId,
        choice: "merge_comments",
        reason: "Add judge feedback.",
      });
      const versions = await versionsOf(db, drawn.tournamentId, seat.id);
      expect(versions[1].scores).toEqual(phone.scores);
      expect(
        await submit(ctx, drawn, seat, { requestId: input.requestId, payload: phone }),
      ).toMatchObject({ status: "received", version: 2, resolution: "merge_comments" });
    },
  );

  it("replays a stored 409 while the conflict is still open", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);
    await submit(ctx, drawn, seat, { payload });
    const changed = withOverall(payload, seat.identity.speakers[0].id, -1);
    const first = await submit(ctx, drawn, seat, { requestId: "stale-replay", payload: changed });
    expect(first).toMatchObject({ status: "conflict", kind: "version" });
    expect(await submit(ctx, drawn, seat, { requestId: "stale-replay", payload: changed })).toEqual(
      first,
    );
    expect(await listOpenConflicts(db, drawn.tournamentId)).toHaveLength(1);
    expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);
  });

  it("turns a lost version write into a conflict with the winning current version", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);
    await submit(testContext(db), drawn, seat, { payload });
    let injected = false;
    const wrapped = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return (callback: (tx: Tx) => Promise<Receipt>) =>
          target.transaction(async (tx) => {
            const guarded = new Proxy(tx, {
              get(inner, txKey, txReceiver) {
                if (txKey !== "transaction") return Reflect.get(inner, txKey, txReceiver);
                return async (write: (sp: Tx) => Promise<unknown>) => {
                  if (!injected) {
                    injected = true;
                    await writeSheetVersion(tx, {
                      tournamentId: drawn.tournamentId,
                      assignmentId: seat.id,
                      expectedVersion: 1,
                      payload: withOverall(payload, seat.identity.speakers[0].id, -1),
                      source: "organiser_correction",
                      actor: { type: "organiser", id: "test-organiser", name: "Sample Organiser" },
                      reason: "Winning correction.",
                      receivedAt: new Date(),
                    });
                  }
                  return inner.transaction(write);
                };
              },
            });
            return callback(guarded);
          });
      },
    });
    const receipt = await submit(testContext(wrapped), drawn, seat, {
      requestId: "lost-write",
      baseVersion: 1,
      payload,
    });
    expect(injected).toBe(true);
    expect(receipt).toMatchObject({ status: "conflict", kind: "version", currentVersion: 2 });
    expect((await versionsOf(db, drawn.tournamentId, seat.id)).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    expect(
      await submit(testContext(db), drawn, seat, {
        requestId: "lost-write",
        baseVersion: 1,
        payload,
      }),
    ).toEqual(receipt);
  });

  it("rolls back an appended version when the pointer compare-and-set loses", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);
    await submit(ctx, drawn, seat, { payload });
    await db.transaction(async (tx) => {
      // A restored pointer may be ahead while the intervening number is free.
      // The insert succeeds, but only the pointer's version decides the winner.
      const [winner] = await tx
        .insert(sheetVersions)
        .values({
          tournamentId: drawn.tournamentId,
          assignmentId: seat.id,
          version: 3,
          scores: payload.scores,
          sideFlipped: payload.sideFlipped,
          roleSwaps: payload.roleSwaps,
          source: "judge",
          actorType: "judge",
          actorId: seat.judgeId,
          actorName: seat.display.judgeName,
        })
        .returning();
      await tx
        .update(sheets)
        .set({ version: 3, currentVersionId: winner.id })
        .where(and(eq(sheets.tournamentId, drawn.tournamentId), eq(sheets.assignmentId, seat.id)));
      expect(
        await writeSheetVersion(tx, {
          tournamentId: drawn.tournamentId,
          assignmentId: seat.id,
          expectedVersion: 1,
          payload,
          source: "judge",
          actor: { type: "judge", id: seat.judgeId, name: seat.display.judgeName },
          receivedAt: ctx.now(),
        }),
      ).toBeNull();
      // Outer transaction stays usable and the losing version was rolled back.
      const versions = await tx
        .select()
        .from(sheetVersions)
        .where(
          and(
            eq(sheetVersions.tournamentId, drawn.tournamentId),
            eq(sheetVersions.assignmentId, seat.id),
          ),
        )
        .orderBy(asc(sheetVersions.version));
      expect(versions.map((v) => v.version)).toEqual([1, 3]);
    });
    expect((await versionsOf(db, drawn.tournamentId, seat.id)).map((v) => v.version)).toEqual([
      1, 3,
    ]);
  });

  it("refuses score overrides without a received sheet and normalises the round before checking duplicates", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);
    const input = {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      kind: "force_include" as const,
      speakerId: seat.identity.speakers[0].id,
      assignmentId: seat.id,
      reason: "Confirmed score.",
    };
    expect(await caught(addOverride(ctx, input))).toMatchObject({ code: "validation" });
    await submit(ctx, drawn, seat);
    expect(await addOverride(ctx, input)).toMatchObject({ round: 1 });
    expect(await caught(addOverride(ctx, { ...input, round: 1 }))).toMatchObject({
      code: "validation",
    });
    await retire(db, drawn, seat);
    expect(await caught(addOverride(ctx, { ...input, kind: "force_exclude" }))).toMatchObject({
      code: "validation",
      message: "That sheet belongs to the old draw.",
    });
  });

  it("returns an internal error for an orphaned version instead of retrying without end", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    const payload = sheetFor(seat);
    await db.insert(sheetVersions).values({
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      version: 1,
      scores: payload.scores,
      sideFlipped: payload.sideFlipped,
      roleSwaps: payload.roleSwaps,
      source: "judge",
      actorType: "judge",
      actorId: seat.judgeId,
      actorName: seat.display.judgeName,
    });
    expect(await caught(submit(testContext(db, { log: silentLogger }), drawn, seat))).toMatchObject(
      { code: "internal", status: 500 },
    );
    expect(
      await db.select().from(submissions).where(eq(submissions.tournamentId, drawn.tournamentId)),
    ).toHaveLength(0);
  });

  it("gives organisers an actionable published-results and old-draw message", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat, old] = seatsIn(drawn, "Open", 1);
    await retire(db, drawn, old);
    expect(
      await caught(
        enterPaperSheet(ctx, {
          tournamentId: drawn.tournamentId,
          assignmentId: old.id,
          payload: sheetFor(old),
          reason: "Paper.",
          judgeNameConfirmed: true,
        }),
      ),
    ).toMatchObject({
      code: "assignment_retired",
      message: `The draw changed; this sheet belongs to the old draw. Use the new sheet for ${old.display.judgeName} in ${old.display.roomName}.`,
    });
    await db
      .update(divisions)
      .set({ finalizedAt: new Date() })
      .where(and(eq(divisions.tournamentId, drawn.tournamentId), eq(divisions.code, "Open")));
    expect(
      await caught(
        waiveSheet(ctx, {
          tournamentId: drawn.tournamentId,
          assignmentId: seat.id,
          reason: "Absent.",
        }),
      ),
    ).toMatchObject({
      code: "division_finalized",
      message: "Results for Open are published. Reopen them first.",
    });
  });

  it("requires reasons centrally for handoffs and revoked waivers", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    for (const action of [AUDIT_ACTIONS.judgeHandoffEntered, "sheet.waiver_revoked"]) {
      expect(
        await caught(
          db.transaction((tx) =>
            recordAudit(tx, ctx, {
              tournamentId: drawn.tournamentId,
              action,
              entityType: "sheet",
              entityId: drawn.assignments[0].id,
              reason: " ",
            }),
          ),
        ),
      ).toMatchObject({ code: "validation" });
    }
  });

  it("retains per-sheet phone progress and marks sheets received after closing as late", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const now = new Date("2026-09-16T12:00:00Z");
    const ctx = testContext(db, { now: () => now });
    const [draft, attention, late] = seatsIn(drawn, "Open", 1);
    const statuses = [
      { assignmentId: draft.id, state: "draft" as const, filled: 12, updatedAt: now.toISOString() },
    ];
    await recordHeartbeat(ctx, {
      tournamentId: drawn.tournamentId,
      judgeId: draft.judgeId,
      deviceId: "draft-phone",
      statuses,
    });
    await recordHeartbeat(ctx, {
      tournamentId: drawn.tournamentId,
      judgeId: attention.judgeId,
      deviceId: "attention-phone",
      statuses: [{ assignmentId: attention.id, state: "attention" }],
    });
    const graph = await loadGraph(db, drawn.tournamentId);
    expect(graph.judgeDevices.find((d) => d.judgeId === draft.judgeId)).toMatchObject({ statuses });
    const board = await liveBoard(db, drawn.tournamentId, 1, { now });
    const seats = board.rooms.flatMap((r) => r.seats);
    expect(seats.find((s) => s.assignmentId === draft.id)).toMatchObject({
      state: "drafting",
      filled: 12,
    });
    expect(seats.find((s) => s.assignmentId === attention.id)).toMatchObject({
      state: "needs-attention",
    });
    await db.transaction(async (tx) => {
      await openRound(tx, ctx, drawn.tournamentId, 1);
      await closeRound(tx, ctx, drawn.tournamentId, 1);
    });
    await submit(testContext(db, { now: () => new Date(now.getTime() + 1000) }), drawn, late);
    expect(
      (await liveBoard(db, drawn.tournamentId, 1)).rooms
        .flatMap((r) => r.seats)
        .find((s) => s.assignmentId === late.id),
    ).toMatchObject({ state: "late" });
    await db.transaction((tx) => reopenRound(tx, ctx, drawn.tournamentId, 1));
    expect(
      (await liveBoard(db, drawn.tournamentId, 1)).rooms
        .flatMap((r) => r.seats)
        .find((s) => s.assignmentId === late.id),
    ).toMatchObject({ state: "in-phone" });
  });

  it.skipIf(!process.env.DATABASE_URL_TEST)(
    "allows ten Postgres writers on one sheet without losing a submission",
    async () => {
      const db = await getDb();
      const drawn = await seedDrawn(db);
      const ctx = testContext(db);
      const [seat] = seatsIn(drawn, "Open", 1);
      const payload = sheetFor(seat);
      const receipts = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          submit(ctx, drawn, seat, { requestId: `pg-writer-${i}`, payload }),
        ),
      );
      expect(receipts.filter((r) => r.status === "received" && !r.absorbed)).toHaveLength(1);
      expect(receipts.every((r) => r.status === "conflict" || r.absorbed || r.version === 1)).toBe(
        true,
      );
      expect(await versionsOf(db, drawn.tournamentId, seat.id)).toHaveLength(1);
      const rows = await db
        .select()
        .from(submissions)
        .where(eq(submissions.tournamentId, drawn.tournamentId));
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.state === "done")).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Waivers, publishing and reopening

describe("waivers and publishing", () => {
  it("publishes once the last missing sheet is waived, snapshots first, and reopens with a reason", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db, "publish");
    const ctx = testContext(db, {
      log: silentLogger,
      actor: { type: "user", id: "org-1", name: "Sam Organiser" },
    });
    const open = drawn.assignments.filter((a) => a.identity.divisionCode === "Open");
    expect(open).toHaveLength(18);
    const [missing, ...rest] = open;
    for (const seat of rest) await submit(ctx, drawn, seat, { payload: sheetFor(seat, "publish") });

    const before = await caught(
      finalizeDivision(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        acknowledgePolicy: true,
      }),
    );
    expect(before).toMatchObject({ code: "validation" });
    const blockers = (before as { details: { blockers: string[] } }).details.blockers;
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain(missing.display.judgeName);
    expect(blockers[0]).toContain("has not been received by the tournament");
    expect(await publishBlockers(db, drawn.tournamentId, "Open")).toEqual(blockers);

    const waiver = await waiveSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: missing.id,
      reason: "The judge had to leave before round 1 finished.",
    });
    expect(waiver).toMatchObject({
      assignmentId: missing.id,
      createdBy: "Sam Organiser",
      revokedAt: null,
    });
    const twice = await caught(
      waiveSheet(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: missing.id,
        reason: "Again.",
      }),
    );
    expect(twice).toMatchObject({ code: "validation" });
    expect(await publishBlockers(db, drawn.tournamentId, "Open")).toEqual([]);

    const unacknowledged = await caught(
      finalizeDivision(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        acknowledgePolicy: false,
      }),
    );
    expect(unacknowledged).toMatchObject({ code: "validation" });

    const published = await finalizeDivision(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      acknowledgePolicy: true,
    });
    expect(published).toMatchObject({
      divisionCode: "Open",
      finalizedBy: "Sam Organiser",
      policy: WORKBOOK_POLICY,
    });
    const [division] = await db
      .select()
      .from(divisions)
      .where(and(eq(divisions.tournamentId, drawn.tournamentId), eq(divisions.code, "Open")));
    expect(division.finalizedAt?.toISOString()).toBe(published.finalizedAt);
    expect(division.finalizedBy).toBe("Sam Organiser");
    expect(division.policySnapshot).toEqual(WORKBOOK_POLICY);
    const snapshots = await db
      .select()
      .from(tournamentSnapshots)
      .where(eq(tournamentSnapshots.tournamentId, drawn.tournamentId));
    expect(snapshots.map((s) => s.kind)).toEqual(["pre_finalize"]);
    expect(snapshots[0].id).toBe(published.snapshotId);

    const view = await divisionResults(db, drawn.tournamentId, "Open");
    expect(view.published).toEqual({ at: published.finalizedAt, by: "Sam Organiser" });
    expect(view.completeness.finalizable).toBe(true);
    expect(view.completeness.missing).toEqual([
      expect.objectContaining({
        assignmentId: missing.id,
        waived: true,
        waiverReason: waiver.reason,
      }),
    ]);

    const again = await caught(
      finalizeDivision(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        acknowledgePolicy: true,
      }),
    );
    expect(again).toMatchObject({ code: "division_finalized", status: 423 });
    const late = await caught(
      submit(ctx, drawn, missing, { payload: sheetFor(missing, "publish") }),
    );
    expect(late).toMatchObject({ code: "division_finalized" });

    const noReason = await caught(
      reopenDivision(ctx, { tournamentId: drawn.tournamentId, divisionCode: "Open", reason: " " }),
    );
    expect(noReason).toMatchObject({ code: "validation" });
    const reopened = await reopenDivision(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      reason: "The waived judge's sheet turned up after all.",
    });
    const [after] = await db
      .select()
      .from(divisions)
      .where(and(eq(divisions.tournamentId, drawn.tournamentId), eq(divisions.code, "Open")));
    expect(after.finalizedAt).toBeNull();
    expect(after.finalizedBy).toBeNull();
    expect(after.policySnapshot).toBeNull();
    const kinds = (
      await db
        .select()
        .from(tournamentSnapshots)
        .where(eq(tournamentSnapshots.tournamentId, drawn.tournamentId))
    ).map((s) => s.kind);
    // SQL without ORDER BY does not promise insertion order.
    expect(kinds.toSorted()).toEqual(["pre_finalize", "pre_unlock"]);
    expect(kinds.length).toBe(2);
    expect(reopened.snapshotId).not.toBe(published.snapshotId);
    const trail = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tournamentId, drawn.tournamentId),
          eq(auditLog.action, "division.reopened"),
        ),
      );
    expect(trail).toHaveLength(1);
    expect(trail[0].reason).toBe("The waived judge's sheet turned up after all.");

    await unwaiveSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: missing.id,
      reason: "The sheet arrived.",
    });
    expect(
      await submit(ctx, drawn, missing, { payload: sheetFor(missing, "publish") }),
    ).toMatchObject({
      status: "received",
      version: 1,
    });
    expect(await publishBlockers(db, drawn.tournamentId, "Open")).toEqual([]);
  });

  it("lists every blocker: two versions, missing sheets and an incomplete draw", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);
    const first = sheetFor(seat);
    await submit(ctx, drawn, seat, { payload: first });
    await submit(ctx, drawn, seat, {
      payload: withOverall(first, seat.identity.speakers[0].id, 9),
    });

    const blockers = await publishBlockers(db, drawn.tournamentId, "Open");
    expect(blockers.some((line) => line.includes("has two versions"))).toBe(true);
    expect(
      blockers.filter((line) => /^Round \d+, .* has not been received/.test(line)),
    ).toHaveLength(17);
    // The four debaters on the one received sheet have a single score each, which
    // the workbook policy cannot check a spread against.
    expect(blockers.filter((line) => line.includes("can't be scored yet"))).toHaveLength(4);

    // A debate taken out of the draw makes the draw incomplete.
    const [debate] = drawn.schedule.debates.filter(
      (d) => d.divisionCode === "Novice" && d.round === 3,
    );
    await db.delete(debateJudges).where(eq(debateJudges.debateId, debate.id));
    await db.delete(debateTeams).where(eq(debateTeams.debateId, debate.id));
    await db.delete(assignments).where(eq(assignments.debateId, debate.id));
    await db.delete(debates).where(eq(debates.id, debate.id));
    const novice = await publishBlockers(db, drawn.tournamentId, "Novice");
    expect(novice.some((line) => line.startsWith("The draw is not complete:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overrides

describe("overrides", () => {
  it("checks the targets for each kind, refuses duplicates and revokes with a reason", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);
    const speakerId = seat.identity.speakers[0].id;
    const noviceSeat = seatsIn(drawn, "Novice", 1)[0];

    const noSheet = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "force_include",
        speakerId,
        reason: "Looks fine to me.",
      }),
    );
    expect(noSheet).toMatchObject({ code: "validation" });
    const wrongDivision = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Novice",
        kind: "exclude_debater",
        speakerId,
        reason: "Withdrew at lunch.",
      }),
    );
    expect(wrongDivision).toMatchObject({ code: "validation" });
    const wrongSheet = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "force_exclude",
        speakerId,
        assignmentId: noviceSeat.id,
        reason: "Wrong room.",
      }),
    );
    expect(wrongSheet).toMatchObject({ code: "validation" });
    const extraField = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "exclude_debater",
        speakerId,
        teamId: seat.identity.governmentTeamId,
        reason: "Withdrew.",
      }),
    );
    expect(extraField).toMatchObject({ code: "validation" });
    const waiverKind = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "waive_missing_sheet" as "force_include",
        assignmentId: seat.id,
        speakerId,
        reason: "Nope.",
      }),
    );
    expect(waiverKind).toMatchObject({ code: "validation" });

    await submit(ctx, drawn, seat);
    const added = await addOverride(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      kind: "force_include",
      speakerId,
      assignmentId: seat.id,
      round: 1,
      reason: "The judge confirmed the score.",
    });
    expect(added).toMatchObject({
      kind: "force_include",
      speakerId,
      assignmentId: seat.id,
      round: 1,
    });
    const duplicate = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "force_include",
        speakerId,
        assignmentId: seat.id,
        round: 1,
        reason: "Again.",
      }),
    );
    expect(duplicate).toMatchObject({ code: "validation", details: { overrideId: added.id } });
    const wrongRound = await caught(
      addOverride(ctx, {
        tournamentId: drawn.tournamentId,
        divisionCode: "Open",
        kind: "force_exclude",
        speakerId,
        assignmentId: seat.id,
        round: 2,
        reason: "Wrong round.",
      }),
    );
    expect(wrongRound).toMatchObject({ code: "validation" });

    const team = await addOverride(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      kind: "rank_single_speaker_team",
      teamId: seat.identity.governmentTeamId,
      reason: "Their partner is ill.",
    });
    expect(await listOverrides(db, drawn.tournamentId, "Open")).toHaveLength(2);

    const revoked = await revokeOverride(ctx, {
      tournamentId: drawn.tournamentId,
      overrideId: team.id,
      reason: "The partner arrived.",
    });
    expect(revoked.revokedReason).toBe("The partner arrived.");
    expect(await listOverrides(db, drawn.tournamentId, "Open")).toHaveLength(1);
    expect(
      await listOverrides(db, drawn.tournamentId, "Open", { includeRevoked: true }),
    ).toHaveLength(2);
    const twice = await caught(
      revokeOverride(ctx, {
        tournamentId: drawn.tournamentId,
        overrideId: team.id,
        reason: "Again.",
      }),
    );
    expect(twice).toMatchObject({ code: "validation" });
    expect(await auditActions(db, drawn.tournamentId)).toEqual([
      "sheet.received",
      "override.added",
      "override.added",
      "override.revoked",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live board and heartbeat

describe("liveBoard and recordHeartbeat", () => {
  it("shows each seat's state from the server first and the phone second", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const now = new Date("2026-09-16T10:30:00.000Z");
    const ctx = testContext(db, { now: () => now, log: silentLogger });
    const [phone, paper, quiet] = seatsIn(drawn, "Open", 1);
    const [waived, handoff, retired] = seatsIn(drawn, "Novice", 1);

    await submit(ctx, drawn, phone);
    const paperPayload = sheetFor(paper);
    await enterPaperSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: paper.id,
      payload: paperPayload,
      reason: "Phone died.",
      judgeNameConfirmed: true,
    });
    await waiveSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: waived.id,
      reason: "Left early.",
    });
    await enterHandoff(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: handoff.id,
      judgeId: handoff.judgeId,
      requestId: "req-h",
      payload: sheetFor(handoff),
      reason: "Hand-off from device.",
    });
    await submit(ctx, drawn, retired);
    const successor = await retire(db, drawn, retired);
    const beat = await recordHeartbeat(ctx, {
      judgeId: quiet.judgeId,
      tournamentId: drawn.tournamentId,
      deviceId: "phone-1",
      online: false,
      appVersion: "1.0.0",
      statuses: [{ assignmentId: quiet.id, state: "queued", updatedAt: now.toISOString() }],
    });
    expect(beat).toEqual({ recorded: true, lastSeenAt: now.toISOString(), queuedCount: 1 });

    const board = await liveBoard(db, drawn.tournamentId, 1, { now });
    expect(board.roundStatus).toBe("pending");
    expect(board.rooms).toHaveLength(4);
    const stateOf = (assignment: AssignmentRow) =>
      board.rooms.flatMap((room) => room.seats).find((seat) => seat.judgeId === assignment.judgeId);
    expect(stateOf(phone)).toMatchObject({ state: "in-phone", version: 1, assignmentId: phone.id });
    expect(stateOf(paper)).toMatchObject({ state: "in-paper", version: 1 });
    expect(stateOf(quiet)).toMatchObject({
      state: "queued-on-phone",
      lastSeenAt: now.toISOString(),
    });
    expect(stateOf(waived)).toMatchObject({ state: "waived" });
    expect(stateOf(handoff)).toMatchObject({ state: "in-handoff" });
    expect(stateOf(retired)).toMatchObject({ state: "old-draw", assignmentId: successor.id });
    expect(board.orphaned).toEqual([
      expect.objectContaining({
        assignmentId: retired.id,
        judgeName: retired.display.judgeName,
        retiredReason: "the draw changed",
        speakersUnchanged: true,
        version: 1,
      }),
    ]);
    const room = board.rooms.find((r) => r.seats.some((s) => s.judgeId === phone.judgeId));
    expect(room?.debate).toMatchObject({ sidesRecorded: "as-drawn", disputed: false });
    expect(room?.divisionCode).toBe("Open");
    expect(board.counts).toEqual({
      expected: 12,
      received: 3,
      notYetIn: 7,
      needsAttention: 1,
      twoVersions: 0,
    });

    // The phone falls silent with unsent work; the round closes; a stale resubmission arrives.
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    await db
      .update(rounds)
      .set({ status: "closed" })
      .where(eq(rounds.tournamentId, drawn.tournamentId));
    await submit(ctx, drawn, phone, {
      payload: withOverall(sheetFor(phone), phone.identity.speakers[0].id, 4),
    });
    const closed = await liveBoard(db, drawn.tournamentId, 1, { now: later });
    const seatOf = (assignment: AssignmentRow) =>
      closed.rooms.flatMap((r) => r.seats).find((s) => s.judgeId === assignment.judgeId);
    expect(seatOf(quiet)?.state).toBe("device-silent");
    expect(seatOf(phone)).toMatchObject({ state: "two-versions" });
    expect(seatOf(phone)?.conflictId).toBeDefined();
    expect(seatOf(seatsIn(drawn, "Open", 1)[1])?.state).toBe("in-paper");
    const missing = closed.rooms.flatMap((r) => r.seats).filter((s) => s.state === "missing");
    expect(missing).toHaveLength(6);
    expect(closed.counts.twoVersions).toBe(1);
    expect(closed.counts.needsAttention).toBe(2);
    expect(closed.roundStatus).toBe("closed");

    await expect(liveBoard(db, drawn.tournamentId, 9)).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates the heartbeat and refuses a judge from another tournament", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const other = await seedDrawn(db, "other");
    const ctx = testContext(db, { log: silentLogger });
    const [seat] = seatsIn(drawn, "Open", 1);

    const malformed = await caught(
      recordHeartbeat(ctx, {
        judgeId: seat.judgeId,
        tournamentId: drawn.tournamentId,
        deviceId: "",
      }),
    );
    expect(malformed).toMatchObject({ code: "validation" });
    const stranger = await caught(
      recordHeartbeat(ctx, {
        judgeId: seat.judgeId,
        tournamentId: other.tournamentId,
        deviceId: "phone-9",
      }),
    );
    expect(stranger).toMatchObject({ code: "forbidden" });

    const first = await recordHeartbeat(ctx, {
      judgeId: seat.judgeId,
      tournamentId: drawn.tournamentId,
      deviceId: "phone-2",
      statuses: [
        { assignmentId: seat.id, state: "draft", filled: 12 },
        { assignmentId: "asg_other", state: "attention" },
      ],
    });
    expect(first).toMatchObject({ recorded: true, queuedCount: 1 });
    const second = await recordHeartbeat(ctx, {
      judgeId: seat.judgeId,
      tournamentId: drawn.tournamentId,
      deviceId: "phone-2",
      statuses: [],
    });
    expect(second).toMatchObject({ recorded: true, queuedCount: 0 });
    const graph = await loadGraph(db, drawn.tournamentId);
    expect(graph.judgeDevices).toHaveLength(1);
    expect(graph.judgeDevices[0]).toMatchObject({ deviceId: "phone-2", queuedAssignmentIds: [] });
  });
});

// Decisions retain the old versions; they only settle the unmatched expectation.
describe("unmatched sheet decisions", () => {
  it("attaches identical debaters to the live successor and preserves the original", async () => {
    const { attachOrphan } = await import("@/server/services/unmatched");
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    await submit(ctx, drawn, seat);
    const successor = await retire(db, drawn, seat);
    const map = Object.fromEntries(seat.identity.speakers.map((s) => [s.id, s.id]));
    expect((await divisionResults(db, drawn.tournamentId, "Open")).completeness.orphaned).toContain(
      seat.id,
    );
    await attachOrphan(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      successorId: successor.id,
      speakerMap: map,
      reason: "Same four debaters checked against the paper.",
    });
    const graph = await loadGraph(db, drawn.tournamentId);
    expect(graph.sheets.find((s) => s.assignmentId === successor.id)?.scores).toEqual(
      graph.sheets.find((s) => s.assignmentId === seat.id)?.scores,
    );
    expect(graph.sheets.find((s) => s.assignmentId === seat.id)).toMatchObject({
      version: 1,
      orphanResolved: true,
    });
    expect(
      (await divisionResults(db, drawn.tournamentId, "Open")).completeness.orphaned,
    ).not.toContain(seat.id);
    expect((await liveBoard(db, drawn.tournamentId, 1)).orphaned).toHaveLength(0);
    expect((await sheetHistory(db, drawn.tournamentId, seat.id)).versions).toHaveLength(1);
  });
  it("refuses changed mappings, another tournament and an already received successor", async () => {
    const { attachOrphan } = await import("@/server/services/unmatched");
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    await submit(ctx, drawn, seat);
    const successor = await retire(db, drawn, seat);
    const input = {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      successorId: successor.id,
      speakerMap: Object.fromEntries(seat.identity.speakers.map((s) => [s.id, s.id])),
      reason: "Checked.",
    };
    await expect(attachOrphan(ctx, { ...input, speakerMap: {} })).rejects.toMatchObject({
      code: "validation",
    });
    const other = await seedDrawn(db);
    await expect(
      attachOrphan(ctx, { ...input, tournamentId: other.tournamentId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await enterPaperSheet(ctx, {
      tournamentId: drawn.tournamentId,
      assignmentId: successor.id,
      payload: sheetFor(seat),
      reason: "Original paper received.",
      judgeNameConfirmed: true,
    });
    await expect(attachOrphan(ctx, input)).rejects.toMatchObject({ code: "validation" });
    expect((await divisionResults(db, drawn.tournamentId, "Open")).completeness.orphaned).toContain(
      seat.id,
    );
  });
  it("sets aside an old sheet with a reason while keeping the new missing sheet and history", async () => {
    const { discardOrphan } = await import("@/server/services/unmatched");
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    await submit(ctx, drawn, seat);
    const successor = await retire(db, drawn, seat);
    const input = {
      tournamentId: drawn.tournamentId,
      assignmentId: seat.id,
      reason: "Wrong matchup; new paper requested.",
    };
    await expect(discardOrphan(ctx, { ...input, reason: "" })).rejects.toMatchObject({
      code: "validation",
    });
    await discardOrphan(ctx, input);
    const view = await divisionResults(db, drawn.tournamentId, "Open");
    expect(view.completeness.orphaned).not.toContain(seat.id);
    expect(view.completeness.missing.map((s) => s.assignmentId)).toContain(successor.id);
    expect(view.completeness.finalizable).toBe(false);
    expect((await sheetHistory(db, drawn.tournamentId, seat.id)).versions).toHaveLength(1);
    await expect(discardOrphan(ctx, input)).rejects.toMatchObject({ code: "validation" });
  });
  it("does not allow an unmatched decision after publication", async () => {
    const { discardOrphan } = await import("@/server/services/unmatched");
    const db = await getDb();
    const drawn = await seedDrawn(db);
    const ctx = testContext(db);
    const [seat] = seatsIn(drawn, "Open", 1);
    await submit(ctx, drawn, seat);
    await retire(db, drawn, seat);
    await db
      .update(divisions)
      .set({ finalizedAt: new Date() })
      .where(and(eq(divisions.tournamentId, drawn.tournamentId), eq(divisions.code, "Open")));
    await expect(
      discardOrphan(ctx, {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        reason: "Too late.",
      }),
    ).rejects.toMatchObject({ code: "division_finalized" });
  });
});

describe("old draw two-version decisions", () => {
  for (const decision of ["discard", "attach"] as const)
    it(`${decision} supersedes competing old versions atomically and preserves incoming history`, async () => {
      const { attachOrphan, discardOrphan } = await import("@/server/services/unmatched");
      const db = await getDb();
      const drawn = await seedDrawn(db);
      const ctx = testContext(db);
      const [seat] = seatsIn(drawn, "Open", 1);
      const payload = sheetFor(seat);
      await submit(ctx, drawn, seat, { payload });
      const incoming = withOverall(payload, seat.identity.speakers[0].id, -3);
      const receipt = await submit(ctx, drawn, seat, { payload: incoming, baseVersion: 0 });
      expect(receipt.status).toBe("conflict");
      const successor = await retire(db, drawn, seat);
      expect((await divisionResults(db, drawn.tournamentId, "Open")).openConflicts).toBe(1);
      const input = {
        tournamentId: drawn.tournamentId,
        assignmentId: seat.id,
        reason: "Reviewed both old versions; current paper is the checked version.",
      };
      if (decision === "discard") await discardOrphan(ctx, input);
      else
        await attachOrphan(ctx, {
          ...input,
          successorId: successor.id,
          speakerMap: Object.fromEntries(seat.identity.speakers.map((s) => [s.id, s.id])),
        });
      const view = await divisionResults(db, drawn.tournamentId, "Open");
      expect(view.openConflicts).toBe(0);
      expect(view.completeness.orphaned).not.toContain(seat.id);
      expect(view.completeness.missing.some((s) => s.assignmentId === successor.id)).toBe(
        decision === "discard",
      );
      const [conflict] = await db
        .select()
        .from(conflicts)
        .where(
          and(eq(conflicts.tournamentId, drawn.tournamentId), eq(conflicts.assignmentId, seat.id)),
        );
      expect(conflict).toMatchObject({
        status: "superseded",
        incoming,
        resolution: { choice: "keep", resolvedBy: ctx.actor.name, resultingVersion: 1 },
      });
      expect(conflict.resolution?.reason).toContain(input.reason);
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tournamentId, drawn.tournamentId),
            eq(
              auditLog.action,
              decision === "attach" ? "sheet.orphan_attached" : "sheet.orphan_discarded",
            ),
          ),
        );
      expect(audit).toMatchObject({
        reason: input.reason,
        after: { supersededConflictIds: [conflict.id] },
      });
      expect((await sheetHistory(db, drawn.tournamentId, seat.id)).versions).toHaveLength(1);
    });
});
