/**
 * Smoke test for the database layer: the schema applies, rows can be written
 * through Drizzle, the relational query API resolves every declared relation,
 * the constraints that protect a tournament day hold, and the migrator is
 * idempotent.
 *
 * Every test seeds its own organisation and tournament with unique slugs, so
 * the file also runs against a shared Postgres (`DATABASE_URL_TEST`).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type {
  AssignmentDisplay,
  AssignmentIdentity,
  TournamentSettings,
} from "../../src/domain/types";
import { closeDb, getDb, migrateDb } from "../../src/server/db/client";
import {
  assignments,
  auditLog,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  judges,
  organisations,
  rooms,
  rounds,
  scoreOverrides,
  sessions,
  sheetVersions,
  sheets,
  speakers,
  teams,
  tournaments,
} from "../../src/server/db/schema";

/** CI points this at a real Postgres; the PGlite-only cases skip there. */
const onRealPostgres = Boolean(process.env.DATABASE_URL_TEST);

/** Invented settings; the shape is what matters here. */
const sampleSettings: TournamentSettings = {
  divisions: [{ code: "Open", name: "Open" }],
  rounds: [
    { number: 1, format: "prepared", sidesDecided: "in-advance" },
    { number: 2, format: "prepared", sidesDecided: "in-advance" },
    { number: 3, format: "impromptu", sidesDecided: "in-room" },
  ],
  rubric: {
    categories: [
      { key: "argumentation", label: "Argumentation", max: 33 },
      { key: "rebuttal", label: "Rebuttal", max: 33 },
      { key: "presentation", label: "Presentation", max: 33 },
      { key: "poi", label: "Points of information", max: 4 },
    ],
    overallMax: 103,
    bands: [{ min: 0, max: 103, label: "All", summary: "Sample band" }],
    noRebuttalScore: 10,
    integersOnly: true,
    commentMaxLength: 4000,
  },
  roles: {
    pm: "Prime Minister",
    lo: "Leader of the Opposition",
    gm: "Government Minister",
    om: "Opposition Member",
  },
  timings: { prepared: [5, 7, 7, 7, 2], impromptu: [4, 5, 5, 5, 1] },
  panelMode: "fixed-room",
  judgesPerRoom: 3,
  feedbackRequired: true,
};

/** Builds one organisation, tournament, division, round and rooms with invented data. */
async function seedTournament() {
  const db = await getDb();
  const suffix = randomUUID().slice(0, 8);

  const [organisation] = await db
    .insert(organisations)
    .values({ slug: `sample-org-${suffix}`, name: "Sample Debating Society" })
    .returning();

  const [tournament] = await db
    .insert(tournaments)
    .values({
      organisationId: organisation.id,
      slug: `sample-${suffix}`,
      name: "Sample Schools Tournament",
      kind: "sandbox",
      settings: sampleSettings,
      scoringPolicy: { sdMultiplier: 2, bounds: "strict" },
    })
    .returning();

  await db
    .insert(divisions)
    .values({ tournamentId: tournament.id, code: "Open", name: "Open", sortOrder: 1 });

  await db.insert(rounds).values([
    { tournamentId: tournament.id, number: 1, format: "prepared" },
    { tournamentId: tournament.id, number: 2, format: "prepared" },
  ]);

  const [roomA, roomB] = await db
    .insert(rooms)
    .values([
      { tournamentId: tournament.id, name: "Room A", sortOrder: 1 },
      { tournamentId: tournament.id, name: "Room B", sortOrder: 2 },
    ])
    .returning();

  return { db, tournament, roomA, roomB };
}

/** Inserts a team and its two debaters. Names are invented. */
async function seedTeam(tournamentId: string, code: string, school: string, name: string) {
  const db = await getDb();
  const [team] = await db
    .insert(teams)
    .values({ tournamentId, divisionCode: "Open", code, name, school })
    .returning();
  const debaters = await db
    .insert(speakers)
    .values([
      { tournamentId, teamId: team.id, position: 1, name: `${code} first speaker` },
      { tournamentId, teamId: team.id, position: 2, name: `${code} second speaker` },
    ])
    .returning();
  return { ...team, debaters };
}

/** Inserts a judge with an invented, unique join token hash. */
async function seedJudge(tournamentId: string, code: string, homeRoomId?: string) {
  const db = await getDb();
  const [judge] = await db
    .insert(judges)
    .values({ tournamentId, code, name: `Judge ${code}`, joinTokenHash: randomUUID(), homeRoomId })
    .returning();
  return judge;
}

type SeededTeam = Awaited<ReturnType<typeof seedTeam>>;

/** A plausible assignment id: `asg_` plus 20 hex characters, as the domain defines it. */
function sampleAssignmentId(): string {
  return `asg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** The two JSON columns of an assignment, filled with the seeded rows' details. */
function assignmentJson(
  debateId: string,
  judge: { id: string; name: string },
  gov: SeededTeam,
  opp: SeededTeam,
): { identity: AssignmentIdentity; display: AssignmentDisplay } {
  const speakersOf = (team: SeededTeam, side: "government" | "opposition") =>
    team.debaters.map((d) => ({
      id: d.id,
      teamId: team.id,
      side,
      position: d.position as 1 | 2,
    }));
  const identitySpeakers = [...speakersOf(gov, "government"), ...speakersOf(opp, "opposition")];
  const roleOf = (side: "government" | "opposition", position: 1 | 2) =>
    side === "government" ? (position === 1 ? "pm" : "gm") : position === 1 ? "lo" : "om";

  return {
    identity: {
      debateId,
      divisionCode: "Open",
      round: 1,
      judgeId: judge.id,
      governmentTeamId: gov.id,
      oppositionTeamId: opp.id,
      speakers: identitySpeakers,
    },
    display: {
      roomName: "Room A",
      judgeName: judge.name,
      roundFormat: "prepared",
      sidesDecided: "in-advance",
      motion: "This house would test its database",
      government: { teamId: gov.id, code: gov.code, name: gov.name, school: gov.school },
      opposition: { teamId: opp.id, code: opp.code, name: opp.name, school: opp.school },
      speakers: identitySpeakers.map((s) => ({
        ...s,
        name: `${s.side} ${s.position}`,
        role: roleOf(s.side, s.position),
      })),
    },
  };
}

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

describe("database schema", () => {
  it("stores a tournament with a team and two debaters", async () => {
    const { db, tournament } = await seedTournament();
    const team = await seedTeam(tournament.id, "O01", "Sample Academy", "Sample Academy A");

    const debaters = await db.select().from(speakers).where(eq(speakers.teamId, team.id));
    expect(debaters.map((d) => d.position).sort()).toEqual([1, 2]);

    const [stored] = await db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(stored.settings.judgesPerRoom).toBe(3);
    expect(stored.kind).toBe("sandbox");
    expect(stored.revision).toBe(0);
  });

  it("derives pair_key as least:greatest of the team ids", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const gov = await seedTeam(tournament.id, "O01", "Sample Academy", "A");
    const opp = await seedTeam(tournament.id, "O02", "Sample College", "A");

    const [debate] = await db
      .insert(debates)
      .values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        round: 1,
        roomId: roomA.id,
        governmentTeamId: gov.id,
        oppositionTeamId: opp.id,
        motion: "This house would test its database",
      })
      .returning();

    const expected = [gov.id, opp.id].sort().join(":");
    expect(debate.pairKey).toBe(expected);
  });

  it("refuses two debates in one room in one round", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const [t1, t2, t3, t4] = await Promise.all([
      seedTeam(tournament.id, "O01", "School One", "A"),
      seedTeam(tournament.id, "O02", "School Two", "A"),
      seedTeam(tournament.id, "O03", "School Three", "A"),
      seedTeam(tournament.id, "O04", "School Four", "A"),
    ]);
    const base = { tournamentId: tournament.id, divisionCode: "Open", round: 1, roomId: roomA.id };

    await db.insert(debates).values({ ...base, governmentTeamId: t1.id, oppositionTeamId: t2.id });

    await expectDbError(
      db.insert(debates).values({ ...base, governmentTeamId: t3.id, oppositionTeamId: t4.id }),
      /debates_room_once/,
    );
  });

  it("refuses the same two teams meeting twice, even with sides swapped", async () => {
    const { db, tournament, roomA, roomB } = await seedTournament();
    const t1 = await seedTeam(tournament.id, "O01", "School One", "A");
    const t2 = await seedTeam(tournament.id, "O02", "School Two", "A");
    const base = { tournamentId: tournament.id, divisionCode: "Open" };

    await db.insert(debates).values({
      ...base,
      round: 1,
      roomId: roomA.id,
      governmentTeamId: t1.id,
      oppositionTeamId: t2.id,
    });

    await expectDbError(
      db.insert(debates).values({
        ...base,
        round: 2,
        roomId: roomB.id,
        governmentTeamId: t2.id,
        oppositionTeamId: t1.id,
      }),
      /debates_pair_once/,
    );
  });

  it("refuses a team debating itself", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const t1 = await seedTeam(tournament.id, "O01", "School One", "A");

    await expectDbError(
      db.insert(debates).values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        round: 1,
        roomId: roomA.id,
        governmentTeamId: t1.id,
        oppositionTeamId: t1.id,
      }),
      /debates_gov_opp_differ/,
    );
  });

  it("refuses a team debating twice in one round, even in different rooms", async () => {
    const { db, tournament, roomA, roomB } = await seedTournament();
    const [t1, t2, t3] = await Promise.all([
      seedTeam(tournament.id, "O01", "School One", "A"),
      seedTeam(tournament.id, "O02", "School Two", "A"),
      seedTeam(tournament.id, "O03", "School Three", "A"),
    ]);
    const base = { tournamentId: tournament.id, divisionCode: "Open", round: 1 };
    const [first, second] = await db
      .insert(debates)
      .values([
        { ...base, roomId: roomA.id, governmentTeamId: t1.id, oppositionTeamId: t2.id },
        { ...base, roomId: roomB.id, governmentTeamId: t3.id, oppositionTeamId: t1.id },
      ])
      .returning();

    await db.insert(debateTeams).values({
      tournamentId: tournament.id,
      debateId: first.id,
      round: 1,
      teamId: t1.id,
      side: "government",
    });
    await expectDbError(
      db.insert(debateTeams).values({
        tournamentId: tournament.id,
        debateId: second.id,
        round: 1,
        teamId: t1.id,
        side: "opposition",
      }),
      /debate_teams_team_once/,
    );
  });

  it("refuses one school entering one team name twice, whatever the case or spacing", async () => {
    const { db, tournament } = await seedTournament();
    await seedTeam(tournament.id, "O01", " sample academy ", "a");

    await expectDbError(
      db.insert(teams).values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        code: "O02",
        school: "Sample Academy",
        name: "A",
      }),
      /teams_school_name_unique/,
    );
  });

  it("treats judge codes as case-insensitive", async () => {
    const { tournament } = await seedTournament();
    await seedJudge(tournament.id, "j1");
    await expectDbError(seedJudge(tournament.id, "J1"), /judges_code_unique/);
  });

  it("treats room names as case-insensitive and ignores surrounding spaces", async () => {
    const { db, tournament } = await seedTournament();
    await expectDbError(
      db.insert(rooms).values({ tournamentId: tournament.id, name: " room a " }),
      /rooms_name_unique/,
    );
  });

  it("refuses a judge session that names no tournament", async () => {
    const { db, tournament } = await seedTournament();
    const judge = await seedJudge(tournament.id, "J1");

    await expectDbError(
      db.insert(sessions).values({
        tokenHash: randomUUID(),
        kind: "judge",
        judgeId: judge.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
      /sessions_kind_shape/,
    );
  });

  it("allows one live assignment per judge and debate, and a successor once it is retired", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const gov = await seedTeam(tournament.id, "O01", "School One", "A");
    const opp = await seedTeam(tournament.id, "O02", "School Two", "A");
    const judge = await seedJudge(tournament.id, "J1", roomA.id);
    const [debate] = await db
      .insert(debates)
      .values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        round: 1,
        roomId: roomA.id,
        governmentTeamId: gov.id,
        oppositionTeamId: opp.id,
      })
      .returning();
    const json = assignmentJson(debate.id, judge, gov, opp);
    const slot = {
      tournamentId: tournament.id,
      debateId: debate.id,
      judgeId: judge.id,
      identityHash: "sample-hash",
      scheduleRevision: 1,
      ...json,
    };

    const firstId = sampleAssignmentId();
    await db.insert(assignments).values({ ...slot, id: firstId });
    await expectDbError(
      db.insert(assignments).values({ ...slot, id: sampleAssignmentId() }),
      /assignments_live_slot/,
    );

    const successorId = sampleAssignmentId();
    await db
      .update(assignments)
      .set({ retiredAt: new Date(), retiredReason: "the draw changed", successorId })
      .where(and(eq(assignments.tournamentId, tournament.id), eq(assignments.id, firstId)));
    await db.insert(assignments).values({ ...slot, id: successorId, scheduleRevision: 2 });

    const live = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.debateId, debate.id), sql`${assignments.retiredAt} is null`));
    expect(live).toEqual([{ id: successorId }]);
  });

  it("requires a reason on every score override", async () => {
    const { db, tournament } = await seedTournament();
    const t1 = await seedTeam(tournament.id, "O01", "School One", "A");

    await expectDbError(
      db.insert(scoreOverrides).values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        teamId: t1.id,
        kind: "rank_single_speaker_team",
        reason: "   ",
      }),
      /score_overrides_reason_present/,
    );
  });

  it("renames a division code through every team and debate", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const gov = await seedTeam(tournament.id, "O01", "School One", "A");
    const opp = await seedTeam(tournament.id, "O02", "School Two", "A");
    await db.insert(debates).values({
      tournamentId: tournament.id,
      divisionCode: "Open",
      round: 1,
      roomId: roomA.id,
      governmentTeamId: gov.id,
      oppositionTeamId: opp.id,
    });

    await db
      .update(divisions)
      .set({ code: "Senior" })
      .where(and(eq(divisions.tournamentId, tournament.id), eq(divisions.code, "Open")));

    const teamCodes = await db
      .select({ divisionCode: teams.divisionCode })
      .from(teams)
      .where(eq(teams.tournamentId, tournament.id));
    expect(teamCodes.map((t) => t.divisionCode)).toEqual(["Senior", "Senior"]);

    const [debate] = await db
      .select({ divisionCode: debates.divisionCode })
      .from(debates)
      .where(eq(debates.tournamentId, tournament.id));
    expect(debate.divisionCode).toBe("Senior");
  });

  it("refuses to delete a room that hosts a debate", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const gov = await seedTeam(tournament.id, "O01", "School One", "A");
    const opp = await seedTeam(tournament.id, "O02", "School Two", "A");
    await db.insert(debates).values({
      tournamentId: tournament.id,
      divisionCode: "Open",
      round: 1,
      roomId: roomA.id,
      governmentTeamId: gov.id,
      oppositionTeamId: opp.id,
    });

    await expectDbError(
      db.delete(rooms).where(eq(rooms.id, roomA.id)),
      /debates_room_id_rooms_id_fk/,
    );
  });
});

describe("relations", () => {
  it("walks every declared relation from a tournament", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const gov = await seedTeam(tournament.id, "O01", "School One", "A");
    const opp = await seedTeam(tournament.id, "O02", "School Two", "A");
    const judge = await seedJudge(tournament.id, "J1", roomA.id);
    const [debate] = await db
      .insert(debates)
      .values({
        tournamentId: tournament.id,
        divisionCode: "Open",
        round: 1,
        roomId: roomA.id,
        governmentTeamId: gov.id,
        oppositionTeamId: opp.id,
      })
      .returning();
    await db.insert(debateTeams).values([
      {
        tournamentId: tournament.id,
        debateId: debate.id,
        round: 1,
        teamId: gov.id,
        side: "government",
      },
      {
        tournamentId: tournament.id,
        debateId: debate.id,
        round: 1,
        teamId: opp.id,
        side: "opposition",
      },
    ]);
    await db.insert(debateJudges).values({
      tournamentId: tournament.id,
      debateId: debate.id,
      round: 1,
      judgeId: judge.id,
      seat: 1,
    });

    const assignmentId = sampleAssignmentId();
    await db.insert(assignments).values({
      tournamentId: tournament.id,
      id: assignmentId,
      debateId: debate.id,
      judgeId: judge.id,
      identityHash: "sample-hash",
      scheduleRevision: 1,
      ...assignmentJson(debate.id, judge, gov, opp),
    });
    const [version] = await db
      .insert(sheetVersions)
      .values({
        tournamentId: tournament.id,
        assignmentId,
        version: 1,
        scores: {},
        source: "judge",
        actorType: "judge",
        actorId: judge.id,
      })
      .returning();
    await db.insert(sheets).values({
      tournamentId: tournament.id,
      assignmentId,
      version: 1,
      currentVersionId: version.id,
    });

    const found = await db.query.tournaments.findFirst({
      where: eq(tournaments.id, tournament.id),
      with: {
        organisation: { with: { memberships: { with: { user: true, organisation: true } } } },
        divisions: { with: { tournament: true, teams: true, debates: true } },
        rooms: { with: { tournament: true, debates: true, homeJudges: true } },
        rounds: { with: { tournament: true } },
        teams: { with: { tournament: true, division: true, speakers: { with: { team: true } } } },
        judges: {
          with: {
            tournament: true,
            homeRoom: true,
            panels: { with: { debate: true, judge: true } },
            assignments: true,
          },
        },
        debates: {
          with: {
            tournament: true,
            division: true,
            room: true,
            governmentTeam: true,
            oppositionTeam: true,
            sides: { with: { debate: true, team: true } },
            panel: true,
            assignments: true,
          },
        },
        assignments: {
          with: {
            tournament: true,
            debate: true,
            judge: true,
            sheet: { with: { assignment: true, currentVersion: true } },
            versions: { with: { assignment: true } },
            conflicts: { with: { assignment: true, judge: true } },
          },
        },
      },
    });

    expect(found).toBeDefined();
    if (!found) return;
    expect(found.organisation.name).toBe("Sample Debating Society");
    expect(found.organisation.memberships).toEqual([]);
    expect(found.divisions[0].teams).toHaveLength(2);
    expect(found.divisions[0].debates).toHaveLength(1);
    expect(found.rounds.map((r) => r.number).sort()).toEqual([1, 2]);

    const roomAFound = found.rooms.find((r) => r.id === roomA.id);
    expect(roomAFound?.debates.map((d) => d.id)).toEqual([debate.id]);
    expect(roomAFound?.homeJudges.map((j) => j.id)).toEqual([judge.id]);

    const govFound = found.teams.find((t) => t.id === gov.id);
    expect(govFound?.division.code).toBe("Open");
    expect(govFound?.speakers).toHaveLength(2);
    expect(govFound?.speakers[0].team.id).toBe(gov.id);

    expect(found.judges[0].homeRoom?.name).toBe("Room A");
    expect(found.judges[0].panels[0].debate.id).toBe(debate.id);
    expect(found.judges[0].assignments.map((a) => a.id)).toEqual([assignmentId]);

    const debateFound = found.debates[0];
    expect(debateFound.room.id).toBe(roomA.id);
    expect(debateFound.governmentTeam.id).toBe(gov.id);
    expect(debateFound.oppositionTeam.id).toBe(opp.id);
    expect(debateFound.sides.map((s) => s.side).sort()).toEqual(["government", "opposition"]);
    expect(debateFound.panel.map((p) => p.judgeId)).toEqual([judge.id]);

    const assignmentFound = found.assignments[0];
    expect(assignmentFound.judge.id).toBe(judge.id);
    expect(assignmentFound.sheet?.currentVersion.version).toBe(1);
    expect(assignmentFound.sheet?.assignment.id).toBe(assignmentId);
    expect(assignmentFound.versions).toHaveLength(1);
    expect(assignmentFound.conflicts).toEqual([]);
  });
});

describe("audit_log", () => {
  it("accepts inserts but raises on update and delete", async () => {
    const { db, tournament } = await seedTournament();

    const [row] = await db
      .insert(auditLog)
      .values({
        tournamentId: tournament.id,
        actorType: "organiser",
        actorId: "sample-organiser",
        action: "setup_saved",
        entityType: "tournament",
        entityId: tournament.id,
        diff: [{ type: "CHANGE", path: ["name"], value: "Renamed" }],
      })
      .returning();
    expect(row.id).toBeGreaterThan(0);

    await expectDbError(
      db.update(auditLog).set({ reason: "tampered" }).where(eq(auditLog.id, row.id)),
      /append-only: UPDATE/,
    );
    await expectDbError(db.delete(auditLog).where(eq(auditLog.id, row.id)), /append-only: DELETE/);

    const [still] = await db.select().from(auditLog).where(eq(auditLog.id, row.id));
    expect(still.reason).toBeNull();
  });

  it("requires a reason for override actions", async () => {
    const { db, tournament } = await seedTournament();
    await expectDbError(
      db.insert(auditLog).values({
        tournamentId: tournament.id,
        actorType: "organiser",
        action: "override_created",
      }),
      /audit_log_reason_required/,
    );
  });
});

describe("cascade policy", () => {
  it("deleting a tournament removes its rows but keeps the audit trail", async () => {
    const { db, tournament, roomA } = await seedTournament();
    const t1 = await seedTeam(tournament.id, "O01", "School One", "A");
    const t2 = await seedTeam(tournament.id, "O02", "School Two", "A");
    await db.insert(debates).values({
      tournamentId: tournament.id,
      divisionCode: "Open",
      round: 1,
      roomId: roomA.id,
      governmentTeamId: t1.id,
      oppositionTeamId: t2.id,
    });
    await db.insert(auditLog).values({
      tournamentId: tournament.id,
      actorType: "system",
      action: "tournament_deleted",
    });

    await db.delete(tournaments).where(eq(tournaments.id, tournament.id));

    const remaining = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teams)
      .where(eq(teams.tournamentId, tournament.id));
    expect(remaining[0].count).toBe(0);

    const trail = await db.select().from(auditLog).where(eq(auditLog.tournamentId, tournament.id));
    expect(trail).toHaveLength(1);
  });
});

describe("migrations", () => {
  it("applies nothing on a second run", async () => {
    // The setup file already migrated this database and reported it.
    const again = await migrateDb();
    expect(again.applied).toBe(0);
    expect(again.recorded).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(onRealPostgres)(
    "reopens an on-disk PGlite database without applying migrations twice",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dais-pglite-"));
      const previousDir = process.env.PGLITE_DIR;
      await closeDb();
      process.env.PGLITE_DIR = dir;
      try {
        // A fresh directory: every migration is applied once, on open, and reported here.
        const first = await migrateDb();
        expect(first.driver).toBe("pglite");
        expect(first.applied).toBe(first.recorded);
        expect(first.recorded).toBeGreaterThanOrEqual(2);
        await closeDb();

        const second = await migrateDb();
        expect(second.applied).toBe(0);
        expect(second.recorded).toBe(first.recorded);

        const db = await getDb();
        await expect(db.select().from(tournaments).limit(1)).resolves.toEqual([]);
      } finally {
        await closeDb();
        process.env.PGLITE_DIR = previousDir;
        fs.rmSync(dir, { recursive: true, force: true });
        // Hand a fresh in-memory database back to any later test and to afterAll.
        await getDb();
      }
    },
  );
});
