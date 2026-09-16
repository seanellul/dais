/**
 * Contract tests for the service foundation: transactions, the audit trail,
 * the tournament graph and its two domain projections, snapshots, and the
 * id helpers. Every later service builds on these, so they are checked
 * against a real (embedded) Postgres rather than mocks.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { generateDraw } from "@/domain/draw";
import { simulateSheet } from "@/domain/sample";
import { deriveAssignments, readiness, validateSchedule } from "@/domain/schedule";
import { WORKBOOK_POLICY, computeDivisionResults } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Schedule } from "@/domain/types";
import {
  assignments,
  auditLog,
  debateJudges,
  debateTeams,
  debates,
  rooms,
  scoreOverrides,
  sheetVersions,
  sheetWaivers,
  sheets,
  tournamentSnapshots,
  type Db,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { errors, isAppError } from "@/server/errors";
import {
  AUDIT_ACTIONS,
  CROCKFORD_ALPHABET,
  JOIN_CODE_PATTERN,
  SNAPSHOT_FORMAT,
  createContext,
  crockfordCode,
  diffOf,
  fingerprintOf,
  hashToken,
  isUniqueViolation,
  joinCode,
  loadGraph,
  newId,
  normaliseCode,
  randomToken,
  recordAudit,
  run,
  sha256Hex,
  snapshotTournament,
  sqlStateOf,
  toDivisionInput,
  toSchedule,
  withTransaction,
} from "@/server/services";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

/** Asserts the promise rejects and that the driver's message matches `pattern`. */
async function expectDbError(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the query to be rejected").toBeDefined();
  const messages = [caught, (caught as { cause?: unknown })?.cause]
    .filter((e): e is Error => e instanceof Error)
    .map((e) => e.message)
    .join("\n");
  expect(messages).toMatch(pattern);
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

/**
 * Stores a full draw for the schedule (debates, sides, panels) with fresh
 * debate ids, then returns the schedule as the database now holds it.
 */
async function storeDraw(db: Db, tournamentId: string, schedule: Schedule): Promise<Schedule> {
  const draw = generateDraw({
    schedule,
    divisionCodes: schedule.settings.divisions.map((division) => division.code),
    seed: "2026-TEST",
    method: "random",
  });
  expect(draw.ok, draw.ok ? "" : draw.error.message).toBe(true);
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
  return toSchedule(await loadGraph(db, tournamentId));
}

describe("withTransaction", () => {
  it("commits what the callback wrote", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db);

    const roomId = await withTransaction(ctx, async (tx) => {
      const [row] = await tx.insert(rooms).values({ tournamentId, name: "Committed" }).returning();
      return row.id;
    });

    const found = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(found.map((room) => room.name)).toEqual(["Committed"]);
  });

  it("rolls back when the callback throws, and rethrows the AppError unchanged", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db);
    const stop = errors.validation("Stop here.");

    const error = await caught(
      withTransaction(ctx, async (tx) => {
        await tx.insert(rooms).values({ tournamentId, name: "Rolled back" });
        throw stop;
      }),
    );
    expect(error).toBe(stop);

    const found = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.tournamentId, tournamentId), eq(rooms.name, "Rolled back")));
    expect(found).toEqual([]);
  });

  it("rethrows a unique violation as the driver raised it", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db);
    await db.insert(rooms).values({ tournamentId, name: "Twice" });

    const error = await caught(
      withTransaction(ctx, async (tx) => {
        await tx.insert(rooms).values({ tournamentId, name: " twice " });
      }),
    );
    expect(isAppError(error)).toBe(false);
    expect(sqlStateOf(error)).toBe("23505");
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("turns a lock or statement timeout into a retryable db_unavailable", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const timeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
      severity: "ERROR",
    });

    const error = await caught(
      withTransaction(ctx, async () => {
        throw timeout;
      }),
    );
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ code: "db_unavailable", status: 503, retryable: true });
    expect((error as Error).cause).toBe(timeout);
  });

  it("does not mistake a Node socket code for a SQLSTATE", () => {
    const socket = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    expect(sqlStateOf(socket)).toBeUndefined();
    expect(sqlStateOf(new Error("plain"))).toBeUndefined();
  });
});

describe("createContext and run", () => {
  it("fills in a request id, a clock and a logger", async () => {
    const db = await getDb();
    const ctx = createContext({ db, actor: { type: "user", id: "u1", name: "Sam" } });
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.now()).toBeInstanceOf(Date);
    expect(typeof ctx.log.info).toBe("function");
  });

  it("wraps data, expected failures and unexpected failures", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });

    expect(await run(ctx, async () => 42)).toEqual({ ok: true, data: 42 });

    const refused = await run(ctx, async () => {
      throw errors.notFound("That sheet");
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "That sheet was not found.",
        retryable: false,
        requestId: ctx.requestId,
      },
    });

    const crashed = await run(ctx, async () => {
      throw new Error("something unexpected");
    });
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    expect(crashed.error.code).toBe("internal");
    expect(crashed.error.requestId).toBe(ctx.requestId);
    expect(JSON.stringify(crashed.error)).not.toContain("something unexpected");
  });
});

describe("recordAudit", () => {
  it("writes a row with the actor, time and request id, and the row cannot be changed", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const at = new Date("2026-09-16T10:04:00.000Z");
    const ctx = testContext(db, {
      actor: { type: "user", id: "user-1", name: "Sam Organiser" },
      now: () => at,
    });

    await withTransaction(ctx, (tx) =>
      recordAudit(tx, ctx, {
        tournamentId,
        action: AUDIT_ACTIONS.settingsUpdated,
        entityType: "tournament",
        entityId: tournamentId,
        diff: diffOf({ name: "Before" }, { name: "After" }),
      }),
    );

    const [row] = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(row).toMatchObject({
      action: "settings.updated",
      actorType: "organiser",
      actorId: "user-1",
      actorName: "Sam Organiser",
      entityType: "tournament",
      entityId: tournamentId,
      requestId: ctx.requestId,
      reason: null,
      divisionCode: null,
      assignmentId: null,
    });
    expect(row.at.getTime()).toBe(at.getTime());
    expect(row.diff).toEqual([
      { type: "CHANGE", path: ["name"], value: "After", oldValue: "Before" },
    ]);

    await expectDbError(
      db.update(auditLog).set({ reason: "tampered" }).where(eq(auditLog.id, row.id)),
      /append-only: UPDATE/,
    );
    await expectDbError(db.delete(auditLog).where(eq(auditLog.id, row.id)), /append-only: DELETE/);
  });

  it("refuses an override without a reason, and trims the reason it stores", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db);
    const entry = {
      tournamentId,
      action: AUDIT_ACTIONS.overrideAdded,
      entityType: "score_override",
      entityId: randomUUID(),
      divisionCode: "Open",
    };

    const error = await caught(recordAudit(db, ctx, { ...entry, reason: "   " }));
    expect(error).toMatchObject({ code: "validation" });

    await recordAudit(db, ctx, { ...entry, reason: "  Judge scored the wrong debater  " });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(row.reason).toBe("Judge scored the wrong debater");
    expect(row.divisionCode).toBe("Open");
  });

  it("diffOf treats empty records and scalars sensibly", () => {
    expect(diffOf(null, { a: 1 })).toEqual([{ type: "CREATE", path: ["a"], value: 1 }]);
    expect(diffOf({ a: 1 }, { a: 1 })).toEqual([]);
    expect(diffOf(1, 2)).toEqual([{ type: "CHANGE", path: ["value"], value: 2, oldValue: 1 }]);
  });
});

describe("loadGraph, toSchedule and toDivisionInput", () => {
  it("throws not_found for an unknown tournament", async () => {
    const db = await getDb();
    const error = await caught(loadGraph(db, randomUUID()));
    expect(error).toMatchObject({ code: "not_found" });
  });

  it("round-trips a seeded roster and reports the missing draw", async () => {
    const db = await getDb();
    const seeded = await seedTournament(db);
    const sample = await seedSample(db, seeded.tournamentId, {
      open: 8,
      novice: 4,
      rooms: 6,
      judgesPerRoom: 3,
      seed: "contracts",
    });

    const graph = await loadGraph(db, seeded.tournamentId);
    expect(graph.loaded).toEqual({
      includeResolved: false,
      includeRevoked: false,
      includeVersions: false,
    });
    expect(graph.sheetVersions).toBeUndefined();
    expect(graph.divisions.map((division) => division.code)).toEqual(["Open", "Novice"]);

    const schedule = toSchedule(graph);
    expect(schedule.settings).toEqual(DEFAULT_SETTINGS);
    expect(schedule.revision).toBe(0);
    expect(schedule.teams).toHaveLength(12);
    expect(schedule.teams.every((team) => team.speakers.length === 2)).toBe(true);
    for (const team of schedule.teams) {
      expect(team.speakers.map((speaker) => speaker.position)).toEqual([1, 2]);
    }
    expect(schedule.rooms.map((room) => room.name)).toEqual(
      sample.roster.rooms.map((room) => room.name),
    );
    expect(schedule.judges).toHaveLength(18);
    const roomIds = new Set(schedule.rooms.map((room) => room.id));
    expect(schedule.judges.every((judge) => roomIds.has(judge.homeRoomId ?? ""))).toBe(true);
    expect(schedule.debates).toEqual([]);

    // A sound roster with no draw is not contradictory...
    expect(validateSchedule(schedule)).toEqual({ ok: true });
    // ...but it is not complete: every team is missing from every round.
    const complete = validateSchedule(schedule, { requireComplete: true });
    expect(complete.ok).toBe(false);
    if (complete.ok) return;
    expect(new Set(complete.issues.map((issue) => issue.code))).toEqual(
      new Set(["draw.missing-team", "draw.sides-unbalanced"]),
    );
    expect(complete.issues.filter((issue) => issue.code === "draw.missing-team")).toHaveLength(
      12 * 3,
    );
    expect(readiness(schedule, "Open").some((issue) => issue.code === "round.debate-count")).toBe(
      true,
    );
  });

  it("projects a drawn division with sheets, waivers and overrides for the scoring engine", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    await seedSample(db, tournamentId, { open: 8, novice: 4, rooms: 6, seed: "contracts" });

    const drawn = await storeDraw(db, tournamentId, toSchedule(await loadGraph(db, tournamentId)));
    expect(validateSchedule(drawn, { requireComplete: true })).toEqual({ ok: true });
    expect(drawn.debates.every((debate) => debate.judgeIds.length === 3)).toBe(true);

    const derived = deriveAssignments(drawn);
    expect(derived.skipped).toEqual([]);
    await db.insert(assignments).values(
      derived.assignments.map((assignment) => ({
        tournamentId,
        id: assignment.id,
        debateId: assignment.identity.debateId,
        judgeId: assignment.identity.judgeId,
        identity: assignment.identity,
        identityHash: fingerprintOf(assignment.identity),
        display: assignment.display,
        scheduleRevision: assignment.scheduleRevision,
      })),
    );

    const open = derived.assignments.filter((a) => a.identity.divisionCode === "Open");
    const [received, waived] = open.filter((a) => a.identity.round === 1);
    const payload = simulateSheet({
      seed: "contracts",
      assignmentDisplay: received.display,
      rubric: DEFAULT_SETTINGS.rubric,
      judgeId: received.identity.judgeId,
    });
    const [version] = await db
      .insert(sheetVersions)
      .values({
        tournamentId,
        assignmentId: received.id,
        version: 1,
        scores: payload.scores,
        sideFlipped: payload.sideFlipped,
        roleSwaps: payload.roleSwaps,
        source: "simulated",
        actorType: "demo",
        actorId: "simulator",
      })
      .returning();
    await db.insert(sheets).values({
      tournamentId,
      assignmentId: received.id,
      version: 1,
      currentVersionId: version.id,
    });
    await db.insert(sheetWaivers).values({
      tournamentId,
      assignmentId: waived.id,
      reason: "The judge had to leave before round 1 finished.",
    });
    const debaterId = received.identity.speakers[0].id;
    await db.insert(scoreOverrides).values({
      tournamentId,
      divisionCode: "Open",
      speakerId: debaterId,
      assignmentId: received.id,
      kind: "force_exclude",
      reason: "Judge scored the wrong debater.",
    });

    const graph = await loadGraph(db, tournamentId);
    expect(graph.assignments).toHaveLength(derived.assignments.length);
    expect(graph.assignments.every((assignment) => assignment.live)).toBe(true);
    expect(graph.sheets).toHaveLength(1);
    expect(graph.sheets[0]).toMatchObject({
      assignmentId: received.id,
      version: 1,
      scores: payload.scores,
      source: "simulated",
      sideFlipped: payload.sideFlipped,
    });

    const input = toDivisionInput(graph, "Open", WORKBOOK_POLICY);
    expect(input.divisionId).toBe("Open");
    expect(input.rounds).toEqual([1, 2, 3]);
    expect(input.debaters).toHaveLength(16);
    expect(input.teams).toHaveLength(8);
    expect(input.teams.every((team) => team.debaterIds.length === 2)).toBe(true);
    expect(input.topN).toBe(2);
    expect(input.policy).toBe(WORKBOOK_POLICY);
    expect(input.expectedSheets).toHaveLength(open.length);
    expect(
      input.expectedSheets.filter((sheet) => sheet.received).map((s) => s.assignmentId),
    ).toEqual([received.id]);
    expect(input.expectedSheets.every((sheet) => sheet.orphaned === undefined)).toBe(true);
    expect(input.expectedSheets[0].debaterIds).toHaveLength(4);

    expect(input.scores).toHaveLength(4);
    for (const score of input.scores) {
      expect(score).toMatchObject({
        assignmentId: received.id,
        judgeId: received.identity.judgeId,
        judgeName: received.display.judgeName,
        round: 1,
        sheetVersion: 1,
        source: "simulation",
        value: payload.scores[score.debaterId].overall,
      });
    }
    expect(input.overrides).toHaveLength(2);
    expect(input.overrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "force_exclude", debaterId, assignmentId: received.id }),
        expect.objectContaining({ kind: "waive_missing_sheet", assignmentId: waived.id }),
      ]),
    );
    expect(input.overrides.find((o) => o.kind === "force_exclude")).not.toHaveProperty("round");

    const results = computeDivisionResults(input);
    expect(results.completeness.expected).toBe(open.length);
    expect(results.completeness.received).toBe(1);
    expect(results.completeness.missing).toHaveLength(open.length - 1);
    expect(results.completeness.missing.find((m) => m.assignmentId === waived.id)?.waived).toBe(
      true,
    );
    expect(results.completeness.provisional).toBe(true);
    // The override reached the engine: the debater carries it and the score is tagged with it.
    const excluded = results.debaters.find((debater) => debater.id === debaterId);
    const overrideId = input.overrides.find((o) => o.kind === "force_exclude")?.id;
    expect(excluded?.overrides.map((override) => override.kind)).toEqual(["force_exclude"]);
    expect(excluded?.rounds[0].sources.map((source) => source.overrideId)).toEqual([overrideId]);

    const novice = toDivisionInput(graph, "Novice", WORKBOOK_POLICY);
    expect(novice.debaters).toHaveLength(8);
    expect(novice.scores).toEqual([]);
    expect(novice.overrides).toEqual([]);
    expect(() => toDivisionInput(graph, "Senior", WORKBOOK_POLICY)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );

    // Retiring the scored assignment leaves its sheet orphaned: listed, not scored.
    await db
      .update(assignments)
      .set({ retiredAt: new Date(), retiredReason: "the draw changed" })
      .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, received.id)));
    const after = toDivisionInput(await loadGraph(db, tournamentId), "Open", WORKBOOK_POLICY);
    expect(after.expectedSheets.find((sheet) => sheet.assignmentId === received.id)).toMatchObject({
      received: true,
      orphaned: true,
    });
    expect(after.scores).toEqual([]);
    expect(computeDivisionResults(after).completeness.orphaned).toEqual([received.id]);
  });
});

describe("snapshotTournament", () => {
  it("stores the full graph and reports its size", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    await seedSample(db, tournamentId, { open: 4, novice: 4, rooms: 4, seed: "snapshot" });
    const at = new Date("2026-09-16T11:30:00.000Z");
    const ctx = testContext(db, { now: () => at });

    const receipt = await withTransaction(ctx, (tx) =>
      snapshotTournament(tx, ctx, tournamentId, "manual", { label: "Before the test" }),
    );
    expect(receipt.byteSize).toBeGreaterThan(1000);

    const [row] = await db
      .select()
      .from(tournamentSnapshots)
      .where(eq(tournamentSnapshots.id, receipt.id));
    expect(row).toMatchObject({
      tournamentId,
      kind: "manual",
      label: "Before the test",
      byteSize: receipt.byteSize,
      createdBy: ctx.actor.name,
    });
    expect(row.createdAt.getTime()).toBe(at.getTime());

    const body = row.body as {
      format: string;
      schemaVersion: number;
      takenAt: string;
      requestId: string;
      graph: {
        tournament: { id: string; createdAt: string };
        teams: unknown[];
        sheetVersions: unknown[];
        loaded: Record<string, boolean>;
      };
    };
    expect(body.format).toBe(SNAPSHOT_FORMAT);
    expect(body.schemaVersion).toBe(1);
    expect(body.takenAt).toBe(at.toISOString());
    expect(body.requestId).toBe(ctx.requestId);
    expect(body.graph.tournament.id).toBe(tournamentId);
    expect(typeof body.graph.tournament.createdAt).toBe("string");
    expect(body.graph.teams).toHaveLength(8);
    expect(body.graph.sheetVersions).toEqual([]);
    expect(body.graph.loaded).toEqual({
      includeResolved: true,
      includeRevoked: true,
      includeVersions: true,
    });
  });
});

describe("ids", () => {
  it("newId is a uuid", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("crockfordCode uses only the Crockford alphabet, never I, L, O or U", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
    for (let i = 0; i < 200; i += 1) {
      const code = crockfordCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
    expect(crockfordCode(10)).toHaveLength(10);
  });

  it("joinCode is four Crockford letters then two digits", () => {
    for (let i = 0; i < 200; i += 1) expect(joinCode()).toMatch(JOIN_CODE_PATTERN);
  });

  it("normaliseCode repairs what a judge is likely to type", () => {
    expect(normaliseCode(" krwp-4o ")).toBe("KRWP40");
    expect(normaliseCode("abcd1l")).toBe("ABCD11");
    expect(normaliseCode("ABCD47")).toBe("ABCD47");
  });

  it("randomToken is base64url of the requested bytes", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(randomToken(6)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("hashToken is deterministic and peppered with the session secret", () => {
    const token = randomToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(sha256Hex(token));
    expect(hashToken(token)).toBe(sha256Hex(`${getEnv().SESSION_SECRET}:${token}`));
  });

  it("fingerprintOf ignores key order and matches sha256 of the canonical JSON", () => {
    expect(fingerprintOf({ a: 1, b: [1, 2] })).toBe(fingerprintOf({ b: [1, 2], a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });
});
