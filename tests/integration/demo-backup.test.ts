/**
 * Demo, simulation, sandbox reset, backup and cleanup, against an embedded
 * Postgres. Every tournament here is invented by `createDemoTournament`.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { issueJoinToken, verifyJoinToken } from "@/server/auth/tokens";
import { createJudgeSession, resolveJudgeSession } from "@/server/auth/judge-session";
import { generateDraw } from "@/domain/draw";
import { WORKBOOK_POLICY, computeDivisionResults } from "@/domain/scoring";
import {
  auditLog,
  conflicts,
  divisions,
  invites,
  judges,
  memberships,
  organisations,
  sheetVersions,
  sheets,
  tournamentSnapshots,
  tournaments,
  users,
  type Db,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { loadGraph, toDivisionInput, toSchedule, withTransaction } from "@/server/services";
import {
  backupChecksum,
  exportBackup,
  importBackup,
  parseBackup,
  restoreInPlace,
} from "@/server/services/backup";
import { cleanupExpired, lazySweep, resetLazySweep } from "@/server/services/cleanup";
import {
  CREATION_SNAPSHOT_LABEL,
  DEMO_LIFETIME_MS,
  createDemoTournament,
  generateSampleInto,
  persistDraw,
} from "@/server/services/demo";
import { resetSandbox } from "@/server/services/sandbox";
import { drawStatus } from "@/server/services/draw";
import {
  introduceConflict,
  simulateRoom,
  simulateRound,
  skipAhead,
} from "@/server/services/simulate";
import { seedTournament, silentLogger, testContext } from "./helpers";

/** Runs `work` and returns whatever it threw. */
async function caught(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Each debater's total, keyed by name, for one division. */
async function totalsByName(db: Db, tournamentId: string, divisionCode: string) {
  const graph = await loadGraph(db, tournamentId);
  const results = computeDivisionResults(toDivisionInput(graph, divisionCode, WORKBOOK_POLICY));
  return {
    results,
    totals: new Map(results.debaters.map((debater) => [debater.name, debater.total])),
  };
}

/** Every uuid primary key a tournament owns, plus its assignment ids. */
async function idsOf(db: Db, tournamentId: string): Promise<Set<string>> {
  const graph = await loadGraph(db, tournamentId, { includeVersions: true });
  const rows = [
    graph.divisions,
    graph.rooms,
    graph.rounds,
    graph.teams,
    graph.speakers,
    graph.judges,
    graph.debates,
    graph.assignments,
    graph.sheetVersions ?? [],
    graph.conflicts,
  ];
  return new Set(rows.flat().map((row) => row.id));
}

async function auditActions(db: Db, tournamentId: string): Promise<string[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
  return rows.map((row) => row.action);
}

describe("createDemoTournament", () => {
  it("publishes the seeded live draw before storing the reset snapshot", async () => {
    const db = await getDb();
    const created = await createDemoTournament(testContext(db), {
      kind: "demo",
      stage: "round1-half",
      seed: "published-live-demo",
    });
    const graph = await loadGraph(db, created.tournamentId);
    expect(await drawStatus(db, created.tournamentId)).toMatchObject({
      status: "published",
      publishedRevision: graph.tournament.revision,
    });
    expect(graph.sheets.length).toBeGreaterThan(0);
    expect(await auditActions(db, created.tournamentId)).toContain("draw.published");
  });

  it("builds a complete tournament: roster, draw, every sheet, and results for both divisions", async () => {
    const db = await getDb();
    const at = new Date("2026-09-16T09:00:00.000Z");
    const ctx = testContext(db, { now: () => at });

    const created = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "complete",
      seed: "complete",
    });
    expect(created.userId).toBeDefined();
    expect(created.drawSeed).toMatch(/^\d{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const graph = await loadGraph(db, created.tournamentId);
    expect(graph.tournament).toMatchObject({
      kind: "demo",
      status: "running",
      drawSeed: created.drawSeed,
    });
    expect(graph.tournament.demoExpiresAt?.getTime()).toBe(at.getTime() + DEMO_LIFETIME_MS);
    expect(graph.teams).toHaveLength(20);
    expect(graph.speakers).toHaveLength(40);
    expect(graph.rooms).toHaveLength(10);
    expect(graph.judges).toHaveLength(30);
    expect(graph.rounds.map((round) => round.number)).toEqual([1, 2, 3]);
    expect(graph.rounds.every((round) => round.status === "closed")).toBe(true);
    for (const round of [1, 2, 3]) {
      expect(graph.debates.filter((debate) => debate.round === round)).toHaveLength(10);
    }
    expect(graph.assignments).toHaveLength(90);
    expect(graph.assignments.every((assignment) => assignment.live)).toBe(true);
    const scored = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
    expect(graph.assignments.every((assignment) => scored.has(assignment.id))).toBe(true);
    expect(graph.sheets.every((sheet) => sheet.source === "simulated")).toBe(true);
    expect(graph.sheets.every((sheet) => sheet.actorType === "demo")).toBe(true);

    for (const code of ["Open", "Novice"]) {
      const { results } = await totalsByName(db, created.tournamentId, code);
      expect(results.completeness.expected).toBe(code === "Open" ? 54 : 36);
      expect(results.completeness.received).toBe(results.completeness.expected);
      expect(results.completeness.missing).toEqual([]);
      expect(results.completeness.provisional).toBe(false);
      expect(results.debaters.every((debater) => debater.total !== null)).toBe(true);
      expect(
        results.debaters.some((debater) =>
          debater.rounds.some((round) => round.sources.some((score) => score.status === "lopped")),
        ),
      ).toBe(true);
    }

    // The throwaway organisation and its synthetic organiser exist.
    const [organisation] = await db
      .select()
      .from(organisations)
      .where(eq(organisations.id, created.organisationId));
    expect(organisation.slug).toMatch(/^demo-/);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.organisationId, created.organisationId));
    expect(membership).toMatchObject({ userId: created.userId, role: "owner" });

    // The creation snapshot is there for a reset.
    const [snapshot] = await db
      .select()
      .from(tournamentSnapshots)
      .where(eq(tournamentSnapshots.id, created.snapshotId));
    expect(snapshot).toMatchObject({ kind: "manual", label: CREATION_SNAPSHOT_LABEL });

    const actions = await auditActions(db, created.tournamentId);
    expect(actions).toContain("demo.created");
    expect(actions).toContain("draw.saved");
    expect(actions.filter((action) => action === "demo.simulated")).toHaveLength(90);
  });

  it("sets a score aside in every division with the default seed and a visitor seed", async () => {
    const db = await getDb();
    const seeds = [undefined, `visitor-${crypto.randomUUID()}`];
    for (const seed of seeds) {
      const created = await createDemoTournament(testContext(db), {
        kind: "demo",
        stage: "complete",
        ...(seed ? { seed } : {}),
      });
      for (const code of ["Open", "Novice"]) {
        const { results } = await totalsByName(db, created.tournamentId, code);
        const setAside = results.debaters.flatMap((debater) =>
          debater.rounds.flatMap((round) =>
            round.sources.filter((source) => source.status === "lopped"),
          ),
        );
        expect(setAside.length, `${seed ?? "default seed"} ${code}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("leaves half of round 1 unscored at stage round1-half", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const created = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "round1-half",
      seed: "half",
    });

    const graph = await loadGraph(db, created.tournamentId);
    // Open has 6 rooms (3 simulated), Novice 4 (2 simulated), three judges each.
    expect(graph.sheets).toHaveLength(15);
    expect(graph.rounds.find((round) => round.number === 1)?.status).toBe("open");
    expect(graph.tournament.status).toBe("running");

    const open = await totalsByName(db, created.tournamentId, "Open");
    expect(open.results.completeness.received).toBe(9);
    expect(open.results.completeness.missing).toHaveLength(45);
    const novice = await totalsByName(db, created.tournamentId, "Novice");
    expect(novice.results.completeness.received).toBe(6);
    expect(novice.results.completeness.missing).toHaveLength(30);
  });

  it("stops at the stage asked for", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const { organisationId } = await seedTournament(db);

    const empty = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "about-to-start",
    });
    const emptyGraph = await loadGraph(db, empty.tournamentId);
    expect(emptyGraph.teams).toEqual([]);
    expect(emptyGraph.divisions.map((d) => d.code)).toEqual(["Open", "Novice"]);
    expect(empty.userId).toBeUndefined();
    expect(emptyGraph.tournament.demoExpiresAt).toBeNull();

    const loaded = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "teams-loaded",
    });
    const loadedGraph = await loadGraph(db, loaded.tournamentId);
    expect(loadedGraph.teams).toHaveLength(20);
    expect(loadedGraph.debates).toEqual([]);
    expect(loaded.drawSeed).toBeNull();

    const drawn = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
    });
    const drawnGraph = await loadGraph(db, drawn.tournamentId);
    expect(drawnGraph.debates).toHaveLength(30);
    expect(drawnGraph.assignments).toHaveLength(90);
    expect(drawnGraph.sheets).toEqual([]);
    expect(drawnGraph.tournament.revision).toBe(1);

    const error = await caught(
      createDemoTournament(testContext(db, { log: silentLogger }), {
        kind: "sandbox",
        stage: "drawn",
      }),
    );
    expect(error).toMatchObject({ code: "validation" });
  });
});

describe("generateSampleInto", () => {
  it("fills an empty setup once, then refuses", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const { tournamentId } = await seedTournament(db);

    const counts = await generateSampleInto(ctx, tournamentId, { open: 4, novice: 4, rooms: 4 });
    expect(counts).toEqual({ teams: 8, debaters: 16, judges: 12, rooms: 4 });
    const graph = await loadGraph(db, tournamentId);
    expect(graph.judges.every((judge) => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(judge.code))).toBe(true);

    const error = await caught(generateSampleInto(ctx, tournamentId));
    expect(error).toMatchObject({ code: "validation" });
    expect((error as Error).message).toMatch(/already has teams, judges or rooms/);
  });
});

describe("simulateRoom", () => {
  it("fills one room only and does nothing the second time", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const { organisationId } = await seedTournament(db);
    const { tournamentId } = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
    });
    const graph = await loadGraph(db, tournamentId);
    const debate = graph.debates.find((d) => d.round === 1 && d.divisionCode === "Open");
    expect(debate).toBeDefined();
    if (!debate) return;

    const first = await simulateRoom(ctx, { tournamentId, round: 1, roomId: debate.roomId });
    expect(first.debateId).toBe(debate.id);
    expect(first.written).toHaveLength(3);
    expect(first.skipped).toBe(0);

    const after = await loadGraph(db, tournamentId);
    expect(after.sheets).toHaveLength(3);
    const onDebate = new Set(
      after.assignments.filter((a) => a.debateId === debate.id).map((a) => a.id),
    );
    expect(after.sheets.every((sheet) => onDebate.has(sheet.assignmentId))).toBe(true);

    const second = await simulateRoom(ctx, { tournamentId, round: 1, roomId: debate.roomId });
    expect(second.written).toEqual([]);
    expect(second.skipped).toBe(3);
    expect((await loadGraph(db, tournamentId)).sheets).toHaveLength(3);

    // The same seed gives the same scores.
    const versions = await db
      .select()
      .from(sheetVersions)
      .where(eq(sheetVersions.tournamentId, tournamentId));
    expect(versions).toHaveLength(3);
    expect(
      versions.every((version) => version.source === "simulated" && version.version === 1),
    ).toBe(true);
  });

  it("simulates a round leaving sheets missing, and skips ahead to results", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const { organisationId } = await seedTournament(db);
    const { tournamentId } = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
    });

    const round = await simulateRound(ctx, { tournamentId, round: 1, leaveMissing: 3 });
    expect(round.written).toHaveLength(27);
    expect(round.leftMissing).toHaveLength(3);
    expect((await loadGraph(db, tournamentId)).sheets).toHaveLength(27);

    const skipped = await skipAhead(ctx, { tournamentId, to: "results" });
    expect(skipped.rounds).toEqual([1, 2, 3]);
    expect(skipped.written).toHaveLength(63);
    const graph = await loadGraph(db, tournamentId);
    expect(graph.sheets).toHaveLength(90);
    expect(graph.rounds.every((r) => r.status === "closed")).toBe(true);
    expect(graph.tournament.status).toBe("running");
  });

  it("is switched off on a live tournament once a real sheet exists", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { tournamentId } = await seedTournament(db, { kind: "live" });
    await generateSampleInto(ctx, tournamentId, { open: 4, novice: 4, rooms: 4, judgesPerRoom: 2 });
    await withTransaction(ctx, async (tx) => {
      const schedule = toSchedule(await loadGraph(tx, tournamentId));
      const draw = generateDraw({
        schedule,
        divisionCodes: ["Open", "Novice"],
        seed: "2026-LIVE",
        method: "random",
      });
      if (!draw.ok) throw new Error(draw.error.message);
      await persistDraw(tx, ctx, tournamentId, draw.debates, { seed: draw.seed });
    });
    const graph = await loadGraph(db, tournamentId);
    const debate = graph.debates[0];

    // Simulation is allowed while nothing real has arrived...
    const first = await simulateRoom(ctx, {
      tournamentId,
      round: debate.round,
      roomId: debate.roomId,
    });
    expect(first.written.length).toBeGreaterThan(0);

    // ...and refused once a judge's own sheet is in.
    const other = graph.assignments.find((a) => a.debateId !== debate.id);
    expect(other).toBeDefined();
    if (!other) return;
    const [version] = await db
      .insert(sheetVersions)
      .values({
        tournamentId,
        assignmentId: other.id,
        version: 1,
        scores: {},
        source: "judge",
        actorType: "judge",
        actorId: other.judgeId,
      })
      .returning();
    await db
      .insert(sheets)
      .values({ tournamentId, assignmentId: other.id, version: 1, currentVersionId: version.id });

    const error = await caught(simulateRound(ctx, { tournamentId, round: 2 }));
    expect(error).toMatchObject({ code: "validation" });
    expect((error as Error).message).toMatch(/simulator is switched off/);
  });
});

describe("introduceConflict", () => {
  it("records an open second version that differs from the current sheet", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { organisationId } = await seedTournament(db);
    const { tournamentId } = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
    });
    const graph = await loadGraph(db, tournamentId);
    const debate = graph.debates[0];
    const { written } = await simulateRoom(ctx, {
      tournamentId,
      round: debate.round,
      roomId: debate.roomId,
    });
    const assignmentId = written[0];

    const result = await introduceConflict(ctx, { tournamentId, assignmentId });
    expect(result).toMatchObject({ assignmentId, currentVersion: 1 });

    const [conflict] = await db.select().from(conflicts).where(eq(conflicts.id, result.conflictId));
    expect(conflict).toMatchObject({
      assignmentId,
      kind: "version",
      status: "open",
      baseVersion: 0,
      currentVersion: 1,
    });
    const current = (await loadGraph(db, tournamentId)).sheets.find(
      (s) => s.assignmentId === assignmentId,
    );
    const differs = Object.entries(conflict.incoming.scores).some(
      ([id, score]) => current?.scores[id]?.overall !== score.overall,
    );
    expect(differs).toBe(true);
    expect(Object.keys(conflict.incoming.scores).sort()).toEqual(
      Object.keys(current?.scores ?? {}).sort(),
    );

    const again = await caught(introduceConflict(ctx, { tournamentId, assignmentId }));
    expect(again).toMatchObject({ code: "validation" });
    const unscored = graph.assignments.find((a) => a.debateId !== debate.id);
    const tooEarly = await caught(
      introduceConflict(ctx, { tournamentId, assignmentId: unscored?.id ?? "" }),
    );
    expect(tooEarly).toMatchObject({ code: "validation" });
  });
});

describe("exportBackup and importBackup", () => {
  it("round-trips a complete tournament into a new sandbox with the same results and no shared ids", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const source = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "complete",
      seed: "backup",
    });
    const { organisationId } = await seedTournament(db);

    const backup = await exportBackup(ctx, source.tournamentId);
    expect(backup.format).toBe("dais-backup");
    expect(backup.schemaVersion).toBe(1);
    expect(backup.checksum).toBe(backupChecksum(backup.tables));
    expect(
      backup.tables.judges.every((judge) => judge.code === null && judge.joinTokenHash === null),
    ).toBe(true);
    expect(backup.tournament.joinCode).toBeNull();
    expect(backup.tables.sheets).toHaveLength(90);
    expect(backup.tables.sheetVersions).toHaveLength(90);
    expect(backup.tables.auditLog.length).toBeGreaterThan(90);

    const withSecrets = await exportBackup(ctx, source.tournamentId, { includeSecrets: true });
    expect(withSecrets.tables.judges.every((judge) => judge.code && judge.joinTokenHash)).toBe(
      true,
    );
    expect(withSecrets.checksum).not.toBe(backup.checksum);

    // The document survives a trip through JSON text, as an upload would.
    const uploaded = JSON.parse(JSON.stringify(backup)) as unknown;
    expect(parseBackup(uploaded).checksum).toBe(backup.checksum);

    const imported = await importBackup(ctx, {
      organisationId,
      backup: withSecrets,
      mode: "new",
      kind: "sandbox",
      name: "Practice copy",
    });
    expect(imported.tournamentId).not.toBe(source.tournamentId);
    expect(imported.counts).toEqual({
      teams: 20,
      judges: 30,
      debates: 30,
      assignments: 90,
      sheets: 90,
    });

    const copy = await loadGraph(db, imported.tournamentId);
    expect(copy.tournament).toMatchObject({
      kind: "sandbox",
      name: "Practice copy",
      organisationId,
      slug: imported.slug,
    });
    expect(copy.tournament.drawSeed).toBe(source.drawSeed);
    expect(
      copy.judges.some((judge) =>
        withSecrets.tables.judges.some((old) => old.joinTokenHash === judge.joinTokenHash),
      ),
    ).toBe(false);
    expect(imported.snapshotId).not.toBeNull();
    expect(copy.judges.every((judge) => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(judge.code))).toBe(true);

    for (const code of ["Open", "Novice"]) {
      const original = await totalsByName(db, source.tournamentId, code);
      const duplicate = await totalsByName(db, imported.tournamentId, code);
      expect(duplicate.results.completeness.received).toBe(original.results.completeness.received);
      expect(duplicate.totals).toEqual(original.totals);
    }

    const sourceIds = await idsOf(db, source.tournamentId);
    const copyIds = await idsOf(db, imported.tournamentId);
    expect(copyIds.size).toBe(sourceIds.size);
    expect([...copyIds].filter((id) => sourceIds.has(id))).toEqual([]);
    expect(await auditActions(db, imported.tournamentId)).toEqual(["backup.imported"]);
  });

  it("can leave the scores behind for a practice copy", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const source = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "complete",
      seed: "clear",
    });
    const { organisationId } = await seedTournament(db);
    await db
      .update(divisions)
      .set({ finalizedAt: new Date(), policySnapshot: WORKBOOK_POLICY })
      .where(eq(divisions.tournamentId, source.tournamentId));
    const backup = await exportBackup(ctx, source.tournamentId);

    const imported = await importBackup(ctx, {
      organisationId,
      backup,
      mode: "new",
      kind: "sandbox",
      clearScores: true,
    });
    const copy = await loadGraph(db, imported.tournamentId);
    expect(copy.assignments).toHaveLength(90);
    expect(copy.sheets).toEqual([]);
    expect(copy.tournament.status).toBe("setup");
    expect(
      copy.divisions.every(
        (division) => division.finalizedAt === null && division.policySnapshot === null,
      ),
    ).toBe(true);
    expect(copy.rounds.every((round) => round.status === "pending")).toBe(true);
  });

  it("refuses a damaged or foreign file", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const source = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "drawn",
      seed: "damaged",
    });
    const { organisationId } = await seedTournament(db);
    const backup = await exportBackup(ctx, source.tournamentId);

    const tampered = JSON.parse(JSON.stringify(backup)) as typeof backup;
    tampered.tables.teams[0].name = "Edited by hand";
    const damaged = await caught(
      importBackup(ctx, { organisationId, backup: tampered, mode: "new", kind: "sandbox" }),
    );
    expect(damaged).toMatchObject({ code: "validation" });
    expect((damaged as Error).message).toMatch(/checksum/);

    const foreign = await caught(
      importBackup(ctx, {
        organisationId,
        backup: { hello: "world" },
        mode: "new",
        kind: "sandbox",
      }),
    );
    expect(foreign).toMatchObject({ code: "validation" });
  });
});

describe("restoreInPlace", () => {
  it("puts the backup back over the same tournament and signs every judge out", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { organisationId } = await seedTournament(db);
    const created = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
      seed: "restore",
    });
    const before = await loadGraph(db, created.tournamentId);
    const printedToken = await withTransaction(ctx, (tx) =>
      issueJoinToken(tx, ctx, before.judges[0].id),
    );
    const oldSession = await withTransaction(ctx, (tx) =>
      createJudgeSession(tx, ctx, before.judges[0].id, created.tournamentId),
    );
    const backup = await exportBackup(ctx, created.tournamentId);

    await simulateRound(ctx, { tournamentId: created.tournamentId, round: 1 });
    expect((await loadGraph(db, created.tournamentId)).sheets).toHaveLength(30);

    const wrongSlug = await caught(
      restoreInPlace(ctx, {
        tournamentId: created.tournamentId,
        backup,
        confirmSlug: "nope",
        reason: "Undo the test run",
      }),
    );
    expect(wrongSlug).toMatchObject({ code: "validation" });
    const noReason = await caught(
      restoreInPlace(ctx, {
        tournamentId: created.tournamentId,
        backup,
        confirmSlug: created.slug,
        reason: " ",
      }),
    );
    expect(noReason).toMatchObject({ code: "validation" });

    const result = await restoreInPlace(ctx, {
      tournamentId: created.tournamentId,
      backup,
      confirmSlug: created.slug,
      reason: "Undo the test run",
    });
    expect(result.checksum).toBe(backup.checksum);
    expect(result.revision).toBe(before.tournament.revision + 1);

    const after = await loadGraph(db, created.tournamentId);
    expect(after.sheets).toEqual([]);
    expect(after.assignments.map((a) => a.id).sort()).toEqual(
      before.assignments.map((a) => a.id).sort(),
    );
    expect(after.debates.map((d) => d.id).sort()).toEqual(before.debates.map((d) => d.id).sort());
    expect(after.judges.map((j) => j.id).sort()).toEqual(before.judges.map((j) => j.id).sort());
    expect(await resolveJudgeSession(db, oldSession.token)).toBeNull();
    expect((await verifyJoinToken(db, printedToken))?.id).toBe(before.judges[0].id);
    expect(after.judges.map((j) => j.code).sort()).toEqual(before.judges.map((j) => j.code).sort());

    const [snapshot] = await db
      .select()
      .from(tournamentSnapshots)
      .where(eq(tournamentSnapshots.id, result.snapshotId));
    expect(snapshot).toMatchObject({ kind: "pre_restore", tournamentId: created.tournamentId });
    const [restored] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tournamentId, created.tournamentId),
          eq(auditLog.action, "backup.restored"),
        ),
      );
    expect(restored.reason).toBe("Undo the test run");
  });

  it("refuses a backup of a different tournament", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { organisationId } = await seedTournament(db);
    const a = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "teams-loaded",
    });
    const b = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "teams-loaded",
    });
    const backupOfA = await exportBackup(ctx, a.tournamentId);

    const error = await caught(
      restoreInPlace(ctx, {
        tournamentId: b.tournamentId,
        backup: backupOfA,
        confirmSlug: b.slug,
        reason: "Mix-up",
      }),
    );
    expect(error).toMatchObject({ code: "validation" });
    expect((error as Error).message).toMatch(/different tournament/);
  });
});

describe("resetSandbox", () => {
  it("can generate another draw after resetting a teams-loaded sandbox", async () => {
    const db = await getDb();
    const ctx = testContext(db);
    const { organisationId } = await seedTournament(db);
    const created = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "teams-loaded",
    });
    const draw = async () =>
      withTransaction(ctx, async (tx) => {
        const graph = await loadGraph(tx, created.tournamentId);
        const generated = generateDraw({
          schedule: toSchedule(graph),
          divisionCodes: ["Open", "Novice"],
          seed: "2026-ABCD",
          method: "random",
        });
        if (!generated.ok) throw new Error(generated.error.message);
        return persistDraw(tx, ctx, created.tournamentId, generated.debates, { seed: "2026-ABCD" });
      });
    await draw();
    const reset = await resetSandbox(ctx, { tournamentId: created.tournamentId });
    const next = await draw();
    expect(next.revision).toBeGreaterThan(reset.revision);
    expect((await loadGraph(db, created.tournamentId)).assignments.length).toBe(90);
  });
  it("returns a drawn sandbox to its creation state", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { organisationId } = await seedTournament(db);
    const created = await createDemoTournament(ctx, {
      kind: "sandbox",
      organisationId,
      stage: "drawn",
      seed: "reset",
    });
    const before = await loadGraph(db, created.tournamentId);

    await simulateRound(ctx, { tournamentId: created.tournamentId, round: 1 });
    await skipAhead(ctx, { tournamentId: created.tournamentId, to: 3 });
    const during = await loadGraph(db, created.tournamentId);
    expect(during.sheets).toHaveLength(60);
    expect(during.tournament.status).toBe("running");

    const result = await resetSandbox(ctx, { tournamentId: created.tournamentId });
    expect(result.snapshotId).toBe(created.snapshotId);
    expect(result.revision).toBe(before.tournament.revision + 1);

    const after = await loadGraph(db, created.tournamentId);
    expect(after.sheets).toEqual([]);
    expect(after.assignments.map((a) => a.id).sort()).toEqual(
      before.assignments.map((a) => a.id).sort(),
    );
    expect(after.debates.map((d) => d.id).sort()).toEqual(before.debates.map((d) => d.id).sort());
    expect(after.teams.map((t) => t.id).sort()).toEqual(before.teams.map((t) => t.id).sort());
    expect(after.rounds.every((round) => round.status === "pending")).toBe(true);
    expect(after.tournament).toMatchObject({
      status: before.tournament.status,
      revision: before.tournament.revision + 1,
    });
    expect(after.tournament.demoLastResetAt).not.toBeNull();
    expect(await auditActions(db, created.tournamentId)).toContain("demo.reset");

    // The creation snapshot survives, so a second reset works too.
    await simulateRoom(ctx, {
      tournamentId: created.tournamentId,
      round: 1,
      roomId: after.debates[0].roomId,
    });
    await resetSandbox(ctx, { tournamentId: created.tournamentId });
    expect((await loadGraph(db, created.tournamentId)).sheets).toEqual([]);
  });

  it("publishes the draw again for a demo created with one, and resets a demo with none", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });

    const drawn = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "drawn",
      seed: "reset-demo",
    });
    await simulateRound(ctx, { tournamentId: drawn.tournamentId, round: 1 });
    const reset = await resetSandbox(ctx, { tournamentId: drawn.tournamentId });
    expect(await drawStatus(db, drawn.tournamentId)).toMatchObject({
      status: "published",
      publishedRevision: reset.revision,
    });
    expect((await loadGraph(db, drawn.tournamentId)).sheets).toEqual([]);

    // No draw at creation: nothing to publish, and the reset must not try.
    const empty = await createDemoTournament(ctx, { kind: "demo", stage: "about-to-start" });
    await generateSampleInto(ctx, empty.tournamentId, { open: 4, novice: 4, rooms: 4 });
    const emptyReset = await resetSandbox(ctx, { tournamentId: empty.tournamentId });
    const after = await loadGraph(db, empty.tournamentId);
    expect(after.teams).toEqual([]);
    expect(after.tournament.revision).toBe(emptyReset.revision);
    expect(await drawStatus(db, empty.tournamentId)).toMatchObject({ status: "draft" });
  });

  it("refuses a live tournament", async () => {
    const db = await getDb();
    const ctx = testContext(db, { log: silentLogger });
    const { tournamentId } = await seedTournament(db, { kind: "live" });
    const error = await caught(resetSandbox(ctx, { tournamentId }));
    expect(error).toMatchObject({ code: "validation" });
    expect((error as Error).message).toMatch(/Only a sandbox or demo/);
  });
});

describe("cleanupExpired", () => {
  it("keeps successful demo deletions when one synthetic user has a foreign reference", async () => {
    const db = await getDb();
    const at = new Date("2020-01-01T00:00:00Z");
    const ctx = testContext(db, { now: () => at, log: silentLogger });
    const first = await createDemoTournament(ctx, { kind: "demo", stage: "about-to-start" });
    const second = await createDemoTournament(ctx, { kind: "demo", stage: "about-to-start" });
    const live = await seedTournament(db, { kind: "live" });
    await db.insert(invites).values({
      organisationId: live.organisationId,
      email: "guest@example.test",
      tokenHash: crypto.randomUUID(),
      invitedBy: first.userId,
      expiresAt: new Date(at.getTime() + 7 * DEMO_LIFETIME_MS),
    });
    const counts = await cleanupExpired(ctx, new Date(at.getTime() + DEMO_LIFETIME_MS + 1));
    // Both tournaments and both organisations go. Only the organiser the
    // invite still names stays, and the counts say exactly that.
    expect(counts).toMatchObject({ demoTournaments: 2, demoOrganisations: 2, demoUsers: 1 });
    for (const demo of [first, second]) {
      expect(
        await db.select().from(tournaments).where(eq(tournaments.id, demo.tournamentId)),
      ).toHaveLength(0);
      expect(
        await db.select().from(organisations).where(eq(organisations.id, demo.organisationId)),
      ).toHaveLength(0);
    }
    expect(
      await db
        .select()
        .from(users)
        .where(eq(users.id, first.userId ?? "")),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(users)
        .where(eq(users.id, second.userId ?? "")),
    ).toHaveLength(0);
  });
  it("removes an expired demo with its organisation and organiser, and keeps a live tournament", async () => {
    const db = await getDb();
    const at = new Date("2026-09-16T09:00:00.000Z");
    const ctx = testContext(db, { now: () => at });
    const demo = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "teams-loaded",
      seed: "expiry",
    });
    const live = await seedTournament(db, { kind: "live" });

    // Before expiry nothing of the demo goes.
    const early = await cleanupExpired(ctx, new Date(at.getTime() + DEMO_LIFETIME_MS - 1000));
    expect(
      await db.select().from(tournaments).where(eq(tournaments.id, demo.tournamentId)),
    ).toHaveLength(1);
    expect(early.demoTournaments).toBe(0);

    const counts = await cleanupExpired(ctx, new Date(at.getTime() + DEMO_LIFETIME_MS + 1000));
    expect(counts.demoTournaments).toBeGreaterThanOrEqual(1);
    expect(counts.demoOrganisations).toBeGreaterThanOrEqual(1);
    expect(counts.demoUsers).toBeGreaterThanOrEqual(1);

    expect(
      await db.select().from(tournaments).where(eq(tournaments.id, demo.tournamentId)),
    ).toEqual([]);
    expect(
      await db.select().from(organisations).where(eq(organisations.id, demo.organisationId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(users)
        .where(eq(users.id, demo.userId ?? "")),
    ).toEqual([]);
    expect(
      await db.select().from(judges).where(eq(judges.tournamentId, demo.tournamentId)),
    ).toEqual([]);

    expect(
      await db.select().from(tournaments).where(eq(tournaments.id, live.tournamentId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(organisations).where(eq(organisations.id, live.organisationId)),
    ).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, live.userId))).toHaveLength(1);
  });

  it("lazySweep runs at most once every ten minutes per process", async () => {
    const db = await getDb();
    let clock = new Date("2026-09-16T12:00:00.000Z").getTime();
    const ctx = testContext(db, { now: () => new Date(clock) });
    resetLazySweep();

    expect(await lazySweep(ctx)).not.toBeNull();
    expect(await lazySweep(ctx)).toBeNull();
    clock += 9 * 60 * 1000;
    expect(await lazySweep(ctx)).toBeNull();
    clock += 2 * 60 * 1000;
    expect(await lazySweep(ctx)).not.toBeNull();
    resetLazySweep();
  });
});
