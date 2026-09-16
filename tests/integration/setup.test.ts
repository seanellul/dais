/**
 * Integration tests for the setup services: tournament creation, the team
 * import, the draw (preview, save, edit, protection, staleness, published
 * divisions), rooms, judges, settings and the dashboard checklist.
 *
 * Every test seeds its own tournament with invented data, so the file also
 * runs against a shared Postgres (`DATABASE_URL_TEST`).
 */
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { simulateSheet } from "@/domain/sample";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Debate } from "@/domain/types";
import {
  assignments,
  auditLog,
  debates,
  divisions,
  judges,
  rounds,
  setupRevisions,
  sheetVersions,
  sheets,
  teams,
  tournamentSnapshots,
  tournaments,
  type Db,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { JOIN_CODE_PATTERN, type ServiceContext } from "@/server/services";
import { checklistStatus, setChecklistOverride } from "@/server/services/checklist";
import { withTransaction } from "@/server/services/context";
import { editDebate, previewDraw, publishDraw, saveDraw, swapTeams } from "@/server/services/draw";
import { loadGraph, toSchedule } from "@/server/services/graph";
import { replaceJudge } from "@/server/services/judges";
import { capacitySummary, createRoom } from "@/server/services/rooms";
import { openRound } from "@/server/services/rounds";
import { updateSettings } from "@/server/services/settings";
import { commitImport, deleteTeam, importTeams, replaceSpeaker } from "@/server/services/teams";
import { createTournament } from "@/server/services/tournaments";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

/** Runs `work` and returns whatever it threw. */
async function caught(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A tournament with 8 Open and 4 Novice teams, 6 rooms and 3 judges per room. */
async function seedRoster(db: Db, seed: string) {
  const seeded = await seedTournament(db);
  const sample = await seedSample(db, seeded.tournamentId, {
    open: 8,
    novice: 4,
    rooms: 6,
    judgesPerRoom: 3,
    seed,
  });
  return { ...seeded, sample };
}

/** Previews and saves a full draw. Returns the save result and the stored debates. */
async function drawAndSave(db: Db, ctx: ServiceContext, tournamentId: string, seed = "2026-TEST") {
  const preview = await previewDraw(db, ctx, tournamentId, {
    divisionCodes: ["Open", "Novice"],
    seed,
    method: "random",
  });
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
  const result = await withTransaction(ctx, (tx) =>
    saveDraw(tx, ctx, tournamentId, {
      baseRevision: tournament.revision,
      debates: preview.debates,
      seed: preview.seed,
    }),
  );
  const stored = toSchedule(await loadGraph(db, tournamentId));
  return { preview, result, debates: stored.debates, revision: result.revision };
}

async function liveAssignments(db: Db, tournamentId: string) {
  const rows = await db
    .select()
    .from(assignments)
    .where(eq(assignments.tournamentId, tournamentId))
    .orderBy(asc(assignments.id));
  return rows.filter((row) => row.retiredAt === null);
}

/** Stores a simulated sheet for an assignment, the way the sheets service will. */
async function insertSheet(db: Db, tournamentId: string, assignmentId: string) {
  const [assignment] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, assignmentId)));
  const payload = simulateSheet({
    seed: "setup-test",
    assignmentDisplay: assignment.display,
    rubric: DEFAULT_SETTINGS.rubric,
    judgeId: assignment.judgeId,
  });
  const [version] = await db
    .insert(sheetVersions)
    .values({
      tournamentId,
      assignmentId,
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
    assignmentId,
    version: 1,
    currentVersionId: version.id,
  });
}

function swapSides(debate: Debate): Debate {
  return {
    ...debate,
    governmentTeamId: debate.oppositionTeamId,
    oppositionTeamId: debate.governmentTeamId,
  };
}

describe("createTournament", () => {
  it("creates the tournament with its divisions, rounds, a join code and a history row", async () => {
    const db = await getDb();
    const { organisationId } = await seedTournament(db);
    const ctx = testContext(db, { actor: { type: "user", id: "user-1", name: "Sam Organiser" } });

    const created = await withTransaction(ctx, (tx) =>
      createTournament(tx, ctx, {
        organisationId,
        name: "Sample Schools Tournament 2027",
        kind: "sandbox",
      }),
    );
    expect(created.slug).toBe("sample-schools-tournament-2027");
    expect(created.joinCode).toMatch(JOIN_CODE_PATTERN);
    expect(created.revision).toBe(0);
    expect(created.settings).toEqual(DEFAULT_SETTINGS);

    const divisionRows = await db
      .select()
      .from(divisions)
      .where(eq(divisions.tournamentId, created.id))
      .orderBy(asc(divisions.sortOrder));
    expect(divisionRows.map((row) => row.code)).toEqual(["Open", "Novice"]);
    const roundRows = await db
      .select()
      .from(rounds)
      .where(eq(rounds.tournamentId, created.id))
      .orderBy(asc(rounds.number));
    expect(roundRows.map((row) => [row.number, row.format])).toEqual([
      [1, "prepared"],
      [2, "prepared"],
      [3, "impromptu"],
    ]);
    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, created.id));
    expect(trail.map((row) => row.action)).toEqual(["tournament.created"]);
    expect(trail[0].actorName).toBe("Sam Organiser");
  });

  it("refuses a second tournament with the same web address in one organisation", async () => {
    const db = await getDb();
    const { organisationId, slug } = await seedTournament(db);
    const ctx = testContext(db, { log: silentLogger });
    const error = await caught(
      withTransaction(ctx, (tx) =>
        createTournament(tx, ctx, { organisationId, name: "Again", slug, kind: "sandbox" }),
      ),
    );
    expect(error).toMatchObject({ code: "validation" });
  });
});

describe("team import", () => {
  it("previews a pasted list and commits it with codes, debaters and a count in the history", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db);
    const text = [
      "School Name\tStudent Name\tTeam Name",
      "Harbourview Academy\tAva Example\tHarbourview Hawks",
      "Harbourview Academy\tBen Sample\tHarbourview Hawks",
      "Clifftop College\tCleo Fictional\tClifftop Kites",
      "Clifftop College\tDev Invented\tClifftop Kites",
    ].join("\n");

    const preview = await importTeams(db, ctx, tournamentId, { text, divisionCode: "Open" });
    expect(preview.ok).toBe(true);
    expect(preview.teams.map((team) => team.code)).toEqual(["O01", "O02"]);

    const committed = await withTransaction(ctx, (tx) =>
      commitImport(tx, ctx, tournamentId, preview),
    );
    expect(committed.counts).toEqual({ teams: 2, debaters: 4, byDivision: { Open: 2 } });
    expect(committed.teams.map((team) => team.speakers.map((s) => s.position))).toEqual([
      [1, 2],
      [1, 2],
    ]);
    const stored = await db.select().from(teams).where(eq(teams.tournamentId, tournamentId));
    expect(stored).toHaveLength(2);
    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(trail.map((row) => row.action)).toContain("teams.imported");

    // A second paste of the same teams is flagged, and the codes carry on from O03.
    const again = await importTeams(db, ctx, tournamentId, { text, divisionCode: "Open" });
    expect(again.teams.map((team) => team.code)).toEqual(["O03", "O04"]);
    expect(again.issues.filter((issue) => issue.level === "warning")).toHaveLength(2);
  });
});

describe("previewDraw and saveDraw", () => {
  it("previews without writing anything", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "preview");
    const ctx = testContext(db);

    const preview = await previewDraw(db, ctx, tournamentId, {
      divisionCodes: ["Open", "Novice"],
      method: "random",
    });
    expect(preview.debates).toHaveLength((4 + 2) * 3);
    expect(preview.seed).toMatch(/^\d{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(preview.issues).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(await db.select().from(debates).where(eq(debates.tournamentId, tournamentId))).toEqual(
      [],
    );
    expect(await liveAssignments(db, tournamentId)).toEqual([]);
  });

  it("persists the debates with three sheets each, bumps the revision and stores the snapshot", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "save");
    const ctx = testContext(db);

    const { result, debates: stored } = await drawAndSave(db, ctx, tournamentId);
    expect(result).toMatchObject({
      revision: 1,
      kept: 0,
      created: 18 * 3,
      retired: [],
      orphaned: [],
    });
    expect(stored).toHaveLength(18);
    expect(stored.every((debate) => debate.judgeIds.length === 3)).toBe(true);

    const live = await liveAssignments(db, tournamentId);
    expect(live).toHaveLength(18 * 3);
    for (const debate of stored) {
      const forDebate = live.filter((row) => row.debateId === debate.id);
      expect(forDebate.map((row) => row.judgeId).sort()).toEqual([...debate.judgeIds].sort());
      expect(forDebate.every((row) => row.scheduleRevision === 1)).toBe(true);
      expect(forDebate.every((row) => row.id.startsWith("asg_"))).toBe(true);
    }

    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    expect(tournament.revision).toBe(1);
    expect(tournament.drawSeed).toBe("2026-TEST");
    const snapshots = await db
      .select()
      .from(setupRevisions)
      .where(eq(setupRevisions.tournamentId, tournamentId));
    expect(snapshots.map((row) => row.revision)).toEqual([1]);
    expect(snapshots[0].snapshot.debates).toHaveLength(18);
    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(trail.map((row) => row.action)).toEqual(["draw.saved"]);
  });

  it("keeps every assignment id when the same debates are saved again", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "again");
    const ctx = testContext(db);
    const first = await drawAndSave(db, ctx, tournamentId);
    const before = await liveAssignments(db, tournamentId);

    const again = await withTransaction(ctx, (tx) =>
      saveDraw(tx, ctx, tournamentId, { baseRevision: first.revision, debates: first.debates }),
    );
    expect(again).toMatchObject({ revision: 2, kept: 54, created: 0, retired: [] });
    const after = await liveAssignments(db, tournamentId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => row.scheduleRevision === 2)).toBe(true);
  });

  it("retires exactly one debate's slots, with successors, when its sides are swapped", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "edit");
    const ctx = testContext(db);
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);
    const before = await liveAssignments(db, tournamentId);
    const target = stored[0];

    const result = await withTransaction(ctx, (tx) =>
      editDebate(tx, ctx, tournamentId, {
        baseRevision: revision,
        debateId: target.id,
        patch: {
          governmentTeamId: target.oppositionTeamId,
          oppositionTeamId: target.governmentTeamId,
        },
      }),
    );
    expect(result.kept).toBe(54 - 3);
    expect(result.created).toBe(3);
    expect(result.retired).toHaveLength(3);
    expect(result.retired.every((slot) => slot.reason === "matchup-changed")).toBe(true);

    const all = await db
      .select()
      .from(assignments)
      .where(eq(assignments.tournamentId, tournamentId));
    const retiredRows = all.filter((row) => row.retiredAt !== null);
    expect(retiredRows.map((row) => row.id).sort()).toEqual(
      before
        .filter((row) => row.debateId === target.id)
        .map((row) => row.id)
        .sort(),
    );
    for (const row of retiredRows) {
      expect(row.retiredReason).toBe("The draw changed.");
      const successor = all.find((candidate) => candidate.id === row.successorId);
      expect(successor).toMatchObject({
        debateId: target.id,
        judgeId: row.judgeId,
        retiredAt: null,
      });
      expect(successor?.identity.governmentTeamId).toBe(target.oppositionTeamId);
    }
    const untouched = before.filter((row) => row.debateId !== target.id);
    const stillLive = all.filter((row) => row.retiredAt === null && row.debateId !== target.id);
    expect(stillLive.map((row) => row.id).sort()).toEqual(untouched.map((row) => row.id).sort());
    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tournamentId, tournamentId))
      .orderBy(asc(auditLog.id));
    expect(trail.map((row) => row.action)).toEqual(["draw.saved", "draw.edited"]);
  });

  it("swaps two teams between debates and retires only those two debates' slots", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "swap");
    const ctx = testContext(db);
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);
    const candidates = stored.filter((d) => d.divisionCode === "Open" && d.round === 2);
    // The database may return UUID-keyed rooms in any order. Pick a legal fixture
    // explicitly; an arbitrary pair may already have met in another round.
    const pair = (a: string, b: string) => [a, b].sort().join(":");
    const chosen = candidates.flatMap((first) => candidates.map((second) => ({ first, second })))
      .find(({ first, second }) => {
        if (first.id === second.id) return false;
        const otherPairs = new Set(stored.filter((d) => d.id !== first.id && d.id !== second.id)
          .map((d) => pair(d.governmentTeamId, d.oppositionTeamId)));
        return !otherPairs.has(pair(second.oppositionTeamId, first.oppositionTeamId))
          && !otherPairs.has(pair(second.governmentTeamId, first.governmentTeamId));
      });
    if (!chosen) throw new Error("Fixture has no legal cross-room swap");
    const { first, second } = chosen;

    const result = await withTransaction(ctx, (tx) =>
      swapTeams(tx, ctx, tournamentId, {
        baseRevision: revision,
        round: 2,
        teamId: first.governmentTeamId,
        otherTeamId: second.oppositionTeamId,
      }),
    );
    expect(result.retired).toHaveLength(6);
    expect(result.created).toBe(6);
    const after = toSchedule(await loadGraph(db, tournamentId)).debates;
    expect(after.find((d) => d.id === first.id)?.governmentTeamId).toBe(second.oppositionTeamId);
    expect(after.find((d) => d.id === second.id)?.oppositionTeamId).toBe(first.governmentTeamId);
  });

  it("swaps the rooms of two debates in one round without tripping the room constraint", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "rooms-swap");
    const ctx = testContext(db);
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);
    const [first, second] = stored.filter((d) => d.round === 1);
    // Judges stay with their room all day, so the panels move with the rooms.
    const swapped = stored.map((debate) => {
      if (debate.id === first.id)
        return { ...debate, roomId: second.roomId, judgeIds: second.judgeIds };
      if (debate.id === second.id)
        return { ...debate, roomId: first.roomId, judgeIds: first.judgeIds };
      return debate;
    });

    const result = await withTransaction(ctx, (tx) =>
      saveDraw(tx, ctx, tournamentId, { baseRevision: revision, debates: swapped }),
    );
    // Each debate's old panel slots go and the new panel's slots are created.
    expect(result.retired).toHaveLength(6);
    expect(result.retired.every((slot) => slot.reason === "slot-removed")).toBe(true);
    expect(result.created).toBe(6);
    expect(result.kept).toBe(54 - 6);
    const after = toSchedule(await loadGraph(db, tournamentId)).debates;
    expect(after.find((d) => d.id === first.id)?.roomId).toBe(second.roomId);
    expect(after.find((d) => d.id === second.id)?.roomId).toBe(first.roomId);
    // The parking room used to break the cycle is gone again, and sheets show the new room.
    const schedule = toSchedule(await loadGraph(db, tournamentId));
    expect(schedule.rooms).toHaveLength(6);
    const secondRoomName = schedule.rooms.find((room) => room.id === second.roomId)?.name;
    const live = await liveAssignments(db, tournamentId);
    expect(live.find((row) => row.debateId === first.id)?.display.roomName).toBe(secondRoomName);
  });

  it("saves a regenerated draw over an existing one by reusing the stored debates", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "regenerate");
    const ctx = testContext(db);
    const first = await drawAndSave(db, ctx, tournamentId, "2026-AAAA");
    const debateIdsBefore = new Set(first.debates.map((debate) => debate.id));

    const second = await drawAndSave(db, ctx, tournamentId, "2026-ZZZZ");
    expect(second.revision).toBe(2);
    expect(second.result.removed).toBe(0);
    expect(second.debates).toHaveLength(18);
    // Every stored row was reused: no debate was deleted or created.
    expect(second.debates.every((debate) => debateIdsBefore.has(debate.id))).toBe(true);
    expect(
      await db.select().from(debates).where(eq(debates.tournamentId, tournamentId)),
    ).toHaveLength(18);
    // Slots whose matchup changed retired with a successor, slots whose panel moved
    // retired without one; either way every new debate has a full live panel.
    const live = await liveAssignments(db, tournamentId);
    expect(live).toHaveLength(54);
    expect(second.result.kept + second.result.created).toBe(54);
    for (const slot of second.result.retired) {
      expect(slot.successorId !== null).toBe(slot.reason === "matchup-changed");
    }
    expect(second.result.retired.length).toBeGreaterThan(0);
  });

  it("refuses a save from a stale page", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "stale");
    const ctx = testContext(db, { log: silentLogger });
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);

    const error = await caught(
      withTransaction(ctx, (tx) =>
        saveDraw(tx, ctx, tournamentId, { baseRevision: revision - 1, debates: stored }),
      ),
    );
    expect(error).toMatchObject({
      code: "setup_stale",
      details: { currentRevision: revision, baseRevision: revision - 1 },
    });
  });

  it("protects a debate with a sheet, and sets the sheet aside only with allowOrphans and a reason", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "protect");
    const ctx = testContext(db, { log: silentLogger });
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);
    const target = stored.find((d) => d.divisionCode === "Open" && d.round === 1) as Debate;
    const [scored] = (await liveAssignments(db, tournamentId)).filter(
      (row) => row.debateId === target.id,
    );
    await insertSheet(db, tournamentId, scored.id);
    const edit = { baseRevision: revision, debateId: target.id, patch: swapSides(target) };

    const refused = await caught(
      withTransaction(ctx, (tx) => editDebate(tx, ctx, tournamentId, edit)),
    );
    expect(refused).toMatchObject({ code: "validation", details: { code: "debate_scored" } });
    expect((refused as Error).message).toContain("already has a sheet");
    const stillReason = await caught(
      withTransaction(ctx, (tx) =>
        editDebate(tx, ctx, tournamentId, { ...edit, allowOrphans: true, reason: "  " }),
      ),
    );
    expect(stillReason).toMatchObject({ code: "validation" });

    const result = await withTransaction(ctx, (tx) =>
      editDebate(tx, ctx, tournamentId, {
        ...edit,
        allowOrphans: true,
        reason: "The room ran the debate with the sides the other way round.",
      }),
    );
    expect(result.orphaned).toEqual([scored.id]);
    expect(result.retired).toHaveLength(3);

    const [retiredRow] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, scored.id)));
    expect(retiredRow.retiredAt).not.toBeNull();
    expect(retiredRow.successorId).toBeTruthy();
    const [sheet] = await db.select().from(sheets).where(eq(sheets.assignmentId, scored.id));
    expect(sheet.version).toBe(1);

    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tournamentId, tournamentId))
      .orderBy(asc(auditLog.id));
    const orphanRow = trail.find((row) => row.action === "draw.sheet_orphaned");
    expect(orphanRow).toMatchObject({
      assignmentId: scored.id,
      divisionCode: "Open",
      reason: "The room ran the debate with the sides the other way round.",
    });
    expect(trail.at(-1)).toMatchObject({ action: "draw.edited", reason: orphanRow?.reason });
    const backups = await db
      .select()
      .from(tournamentSnapshots)
      .where(eq(tournamentSnapshots.tournamentId, tournamentId));
    expect(backups.map((row) => row.kind)).toEqual(["pre_draw_save"]);
  });

  it("never touches assignments when an unused room is added", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "room");
    const ctx = testContext(db);
    const { revision } = await drawAndSave(db, ctx, tournamentId);
    const before = await db
      .select()
      .from(assignments)
      .where(eq(assignments.tournamentId, tournamentId))
      .orderBy(asc(assignments.id));

    const room = await withTransaction(ctx, (tx) =>
      createRoom(tx, ctx, tournamentId, { name: "Spare Room" }),
    );
    expect(room.sortOrder).toBe(7);
    const after = await db
      .select()
      .from(assignments)
      .where(eq(assignments.tournamentId, tournamentId))
      .orderBy(asc(assignments.id));
    expect(after).toEqual(before);
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    expect(tournament.revision).toBe(revision);
  });

  it("refuses to change a published division but still accepts changes elsewhere", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "published");
    const ctx = testContext(db, { log: silentLogger });
    const { debates: stored, revision } = await drawAndSave(db, ctx, tournamentId);
    await db
      .update(divisions)
      .set({ finalizedAt: new Date(), finalizedBy: "Test runner" })
      .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, "Open")));
    const open = stored.find((d) => d.divisionCode === "Open") as Debate;
    const novice = stored.find((d) => d.divisionCode === "Novice") as Debate;

    const refused = await caught(
      withTransaction(ctx, (tx) =>
        editDebate(tx, ctx, tournamentId, {
          baseRevision: revision,
          debateId: open.id,
          patch: swapSides(open),
        }),
      ),
    );
    expect(refused).toMatchObject({
      code: "division_finalized",
      details: { divisionCode: "Open" },
    });

    const room = await withTransaction(ctx, (tx) =>
      createRoom(tx, ctx, tournamentId, { name: "Overflow" }),
    );
    expect(room.name).toBe("Overflow");
    // Saving the same draw affects no division, so it goes through.
    const resaved = await withTransaction(ctx, (tx) =>
      saveDraw(tx, ctx, tournamentId, { baseRevision: revision, debates: stored }),
    );
    expect(resaved.retired).toEqual([]);
    const noviceEdit = await withTransaction(ctx, (tx) =>
      editDebate(tx, ctx, tournamentId, {
        baseRevision: resaved.revision,
        debateId: novice.id,
        patch: swapSides(novice),
      }),
    );
    expect(noviceEdit.retired).toHaveLength(3);
  });
});

describe("checklistStatus", () => {
  it("moves from not started to done as the tournament fills in", async () => {
    const db = await getDb();
    const { tournamentId } = await seedTournament(db);
    const ctx = testContext(db, { log: silentLogger });
    const stateOf = async () => {
      const status = await checklistStatus(db, tournamentId);
      return {
        next: status.next,
        states: Object.fromEntries(status.steps.map((step) => [step.key, step.state])),
      };
    };

    const empty = await stateOf();
    expect(empty.next).toBe("teams");
    expect(empty.states).toEqual({
      teams: "not-started",
      judges: "not-started",
      rooms: "not-started",
      draw: "not-started",
      round1: "not-started",
      round2: "not-started",
      round3: "not-started",
      results: "not-started",
    });

    await seedSample(db, tournamentId, { open: 8, novice: 4, rooms: 6, seed: "checklist" });
    const rostered = await stateOf();
    expect(rostered.states).toMatchObject({
      teams: "done",
      judges: "done",
      rooms: "done",
      draw: "ready",
    });
    expect(rostered.next).toBe("draw");

    const { revision } = await drawAndSave(db, ctx, tournamentId);
    const drawn = await checklistStatus(db, tournamentId);
    expect(drawn.steps.find((step) => step.key === "draw")).toMatchObject({
      state: "ready",
      summary: "18 debates over 3 rounds; ready to publish.",
    });

    await withTransaction(ctx, (tx) =>
      publishDraw(tx, ctx, tournamentId, { baseRevision: revision }),
    );
    const published = await stateOf();
    expect(published.states).toMatchObject({
      draw: "done",
      round1: "ready",
      round2: "not-started",
    });
    expect(published.next).toBe("round1");

    await withTransaction(ctx, (tx) => openRound(tx, ctx, tournamentId, 1));
    const opened = await checklistStatus(db, tournamentId);
    expect(opened.steps.find((step) => step.key === "round1")).toMatchObject({
      state: "in-progress",
      summary: "Open; 0 of 18 sheets received.",
    });

    const blank = await caught(
      withTransaction(ctx, (tx) =>
        setChecklistOverride(tx, ctx, tournamentId, "results", "done", " "),
      ),
    );
    expect(blank).toMatchObject({ code: "validation" });
    await withTransaction(ctx, (tx) =>
      setChecklistOverride(
        tx,
        ctx,
        tournamentId,
        "results",
        "skipped",
        "Results announced on paper.",
      ),
    );
    const overridden = await checklistStatus(db, tournamentId);
    expect(overridden.steps.find((step) => step.key === "results")).toMatchObject({
      state: "done",
      override: { state: "skipped", reason: "Results announced on paper." },
    });
    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(trail.map((row) => row.action)).toContain("checklist.overridden");
  });
});

describe("replaceJudge", () => {
  it("moves only the unscored sheets to the new judge and signs the old judge out", async () => {
    const db = await getDb();
    const { tournamentId, sample } = await seedRoster(db, "replace");
    const ctx = testContext(db);
    await drawAndSave(db, ctx, tournamentId);
    const old = sample.judges[0];
    const before = (await liveAssignments(db, tournamentId)).filter(
      (row) => row.judgeId === old.id,
    );
    expect(before).toHaveLength(3);
    const scored = before.find((row) => row.identity.round === 1) as (typeof before)[number];
    await insertSheet(db, tournamentId, scored.id);

    const result = await withTransaction(ctx, (tx) =>
      replaceJudge(tx, ctx, tournamentId, {
        oldJudgeId: old.id,
        newName: "Replacement Judge",
        reason: "Had to leave after round 1.",
      }),
    );
    expect(result.keptDebateIds).toEqual([scored.debateId]);
    expect(result.movedSheets.map((sheet) => sheet.round).sort()).toEqual([2, 3]);
    expect(result.joinToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result.newJudge.homeRoomId).toBe(old.homeRoomId);

    const all = await db
      .select()
      .from(assignments)
      .where(eq(assignments.tournamentId, tournamentId));
    const stillOld = all.filter((row) => row.judgeId === old.id && row.retiredAt === null);
    expect(stillOld.map((row) => row.id)).toEqual([scored.id]);
    const moved = all.filter((row) => row.judgeId === old.id && row.retiredAt !== null);
    expect(moved).toHaveLength(2);
    for (const row of moved) {
      expect(row.retiredReason).toBe("The draw changed.");
      const successor = all.find((candidate) => candidate.id === row.successorId);
      expect(successor).toMatchObject({
        judgeId: result.newJudge.id,
        debateId: row.debateId,
        retiredAt: null,
      });
    }
    expect(result.movedSheets.map((sheet) => sheet.successorId).sort()).toEqual(
      moved.map((row) => row.successorId).sort(),
    );
    const [oldRow] = await db.select().from(judges).where(eq(judges.id, old.id));
    expect(oldRow).toMatchObject({ status: "withdrawn", sessionEpoch: 1 });
    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournamentId));
    expect(trail.map((row) => row.action)).toEqual(
      expect.arrayContaining(["judges.created", "judges.sessions_revoked", "judges.replaced"]),
    );
  });
});

describe("teams, rooms and settings", () => {
  it("withdraws a drawn team, deletes an undrawn one, and refuses a scored one", async () => {
    const db = await getDb();
    const { tournamentId, sample } = await seedRoster(db, "teams");
    const ctx = testContext(db, { log: silentLogger });

    const undrawn = await withTransaction(ctx, (tx) =>
      deleteTeam(tx, ctx, tournamentId, sample.teams[0].id),
    );
    expect(undrawn).toEqual({ status: "deleted" });
    const spare = await withTransaction(ctx, (tx) =>
      commitImport(tx, ctx, tournamentId, {
        teams: [
          {
            code: "O99",
            name: "Late Entry",
            school: "Sample Academy",
            divisionCode: "Open",
            speakers: [
              { name: "Erin Example", position: 1 },
              { name: "Finn Sample", position: 2 },
            ],
            row: 1,
          },
        ],
      }),
    );
    expect(spare.teams).toHaveLength(1);

    await drawAndSave(db, ctx, tournamentId);
    const drawnTeam = sample.teams[1];
    const withdrawn = await withTransaction(ctx, (tx) =>
      deleteTeam(tx, ctx, tournamentId, drawnTeam.id),
    );
    expect(withdrawn).toEqual({ status: "withdrawn" });

    const scoredTeam = sample.teams[2];
    const [assignment] = (await liveAssignments(db, tournamentId)).filter(
      (row) =>
        row.identity.governmentTeamId === scoredTeam.id ||
        row.identity.oppositionTeamId === scoredTeam.id,
    );
    await insertSheet(db, tournamentId, assignment.id);
    const refused = await caught(
      withTransaction(ctx, (tx) => deleteTeam(tx, ctx, tournamentId, scoredTeam.id)),
    );
    expect((refused as Error).message).toContain("This team already has scores");
  });

  it("replaces a debater and retires the team's sheets with successors", async () => {
    const db = await getDb();
    const { tournamentId, sample } = await seedRoster(db, "speaker");
    const ctx = testContext(db);
    await drawAndSave(db, ctx, tournamentId);
    const team = sample.teams[3];

    const result = await withTransaction(ctx, (tx) =>
      replaceSpeaker(tx, ctx, tournamentId, team.id, 2, "Gina Fictional"),
    );
    expect(result.speaker.name).toBe("Gina Fictional");
    expect(result.draw?.retired).toHaveLength(3 * 3);
    expect(result.draw?.created).toBe(3 * 3);
    const live = await liveAssignments(db, tournamentId);
    const forTeam = live.filter((row) => row.identity.speakers.some((s) => s.teamId === team.id));
    expect(
      forTeam.every((row) => row.identity.speakers.some((s) => s.id === result.speaker.id)),
    ).toBe(true);
  });

  it("says in words whether the rooms and judges are enough", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "capacity");
    const summary = await capacitySummary(db, tournamentId);
    expect(summary).toMatchObject({
      roomsNeeded: 6,
      roomsAvailable: 6,
      roomsShort: 0,
      judgesNeeded: 18,
      judgesAvailable: 18,
      judgesShort: 0,
    });
    expect(summary.sentence).toBe(
      "Each round needs 6 rooms at once (4 for Open (competitive) and 2 for Novice (learning)); 6 rooms are listed. " +
        "With 3 judges per room that takes 18 judges; 18 judges are listed.",
    );
  });

  it("keeps the rubric and rounds fixed once a sheet has arrived", async () => {
    const db = await getDb();
    const { tournamentId } = await seedRoster(db, "settings");
    const ctx = testContext(db, { log: silentLogger });
    const changed = await withTransaction(ctx, (tx) =>
      updateSettings(tx, ctx, tournamentId, { judgesPerRoom: 2 }),
    );
    expect(changed.judgesPerRoom).toBe(2);

    await drawAndSave(db, ctx, tournamentId);
    const [assignment] = await liveAssignments(db, tournamentId);
    await insertSheet(db, tournamentId, assignment.id);
    const refused = await caught(
      withTransaction(ctx, (tx) =>
        updateSettings(tx, ctx, tournamentId, {
          rubric: { ...DEFAULT_SETTINGS.rubric, noRebuttalScore: 10 },
        }),
      ),
    );
    expect(refused).toMatchObject({ code: "validation" });
    expect((refused as Error).message).toContain("can't be changed now");
    const stillFine = await withTransaction(ctx, (tx) =>
      updateSettings(tx, ctx, tournamentId, { feedbackRequired: true }),
    );
    expect(stillFine.feedbackRequired).toBe(true);
  });
});
