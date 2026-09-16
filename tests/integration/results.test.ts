/**
 * Results against an embedded Postgres: a rogue score is set aside and the
 * judge is named, an organiser override brings it back, a debater who can't
 * be scored yet never blocks the others, and a published division keeps
 * scoring under the policy stamped on it.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { generateDraw } from "@/domain/draw";
import { simulateSheet } from "@/domain/sample";
import { assignmentId, displayOf, identityOf } from "@/domain/schedule";
import { WORKBOOK_POLICY } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Schedule } from "@/domain/types";
import {
  assignments,
  debateJudges,
  debateTeams,
  debates,
  tournaments,
  type AssignmentRow,
  type Db,
  type NewAssignmentRow,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { fingerprintOf, loadGraph, toSchedule, type ServiceContext } from "@/server/services";
import { finalizeDivision, reopenDivision } from "@/server/services/finalize";
import { addOverride } from "@/server/services/overrides";
import { divisionResults, parseScoringPolicy } from "@/server/services/results";
import { receiveSheet } from "@/server/services/sheets";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

interface Drawn {
  tournamentId: string;
  schedule: Schedule;
  assignments: AssignmentRow[];
}

/** 4 + 4 teams, 4 rooms, 3 judges per room, with a stored draw and live assignments. */
async function seedDrawn(db: Db, seed: string): Promise<Drawn> {
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
  return { tournamentId, schedule, assignments: inserted };
}

/** Submits a simulated sheet for an assignment, optionally with one planted rogue score. */
async function simulateAndSubmit(
  ctx: ServiceContext,
  drawn: Drawn,
  assignment: AssignmentRow,
  seed: string,
  rogueSpeakerId?: string,
  fixedSpeakerId?: string,
): Promise<void> {
  const payload = simulateSheet({
    seed,
    assignmentDisplay: assignment.display,
    rubric: DEFAULT_SETTINGS.rubric,
    judgeId: assignment.judgeId,
    rogueChance: 0,
    ...(rogueSpeakerId ? { plantRogue: { speakerId: rogueSpeakerId } } : {}),
  });
  if (fixedSpeakerId) {
    // Fixed policy example: changing generated UUIDs must not change which score is an outlier.
    payload.scores[fixedSpeakerId].overall = rogueSpeakerId ? 103 : 78 + assignment.identity.round;
  }
  const receipt = await receiveSheet(ctx, {
    tournamentId: drawn.tournamentId,
    judgeId: assignment.judgeId,
    assignmentId: assignment.id,
    requestId: `req-${randomUUID()}`,
    baseVersion: 0,
    payload,
  });
  expect(receipt.status).toBe("received");
}

/** The assignments on every debate of one team, one debate per round. */
function sheetsOfTeam(drawn: Drawn, teamId: string): AssignmentRow[] {
  return drawn.assignments.filter(
    (a) => a.identity.governmentTeamId === teamId || a.identity.oppositionTeamId === teamId,
  );
}

describe("divisionResults", () => {
  it("names the judge whose score was set aside, and a force_include brings it back", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db, "results");
    const ctx = testContext(db);
    const team = drawn.schedule.teams.find((t) => t.divisionCode === "Open");
    if (!team) throw new Error("no Open team");
    const [first, second] = team.speakers.map((speaker) => speaker.id);
    const teamSheets = sheetsOfTeam(drawn, team.id);
    expect(teamSheets).toHaveLength(9);
    const rogue = teamSheets.find((a) => a.identity.round === 2);
    if (!rogue) throw new Error("no round 2 sheet");

    for (const sheet of teamSheets) {
      await simulateAndSubmit(
        ctx,
        drawn,
        sheet,
        "results",
        sheet.id === rogue.id ? first : undefined,
        first,
      );
    }

    const view = await divisionResults(db, drawn.tournamentId, "Open");
    expect(view.divisionCode).toBe("Open");
    expect(view.published).toBeNull();
    expect(view.policy).toEqual(WORKBOOK_POLICY);
    expect(view.policyText).toContain("set aside");

    const debater = view.debaters.find((d) => d.id === first);
    if (!debater) throw new Error("debater missing");
    expect(debater).toMatchObject({ teamCode: team.code, status: "ready", statusWords: "ready" });
    expect(debater.rounds.flatMap((round) => round.scores)).toHaveLength(9);
    expect(debater.rank).not.toBeNull();
    expect(debater.range.scope).toBe("pooled");
    expect(debater.range.lower).not.toBeNull();

    // Noise can put one more honest score just outside the kept range, so the
    // planted one is found by its sheet rather than assumed to be alone.
    const isPlanted = (entry: { assignmentId: string; debaterId: string }) =>
      entry.assignmentId === rogue.id && entry.debaterId === first;
    const planted = view.setAside.find(isPlanted);
    expect(planted).toMatchObject({
      debaterId: first,
      debaterName: debater.name,
      round: 2,
      assignmentId: rogue.id,
      judgeId: rogue.judgeId,
      judgeName: rogue.display.judgeName,
      byOrganiser: false,
    });
    if (!planted) return;
    expect(planted.sentence).toContain(rogue.display.judgeName);
    expect(planted.sentence).toMatch(/set aside/i);
    const roundTwo = debater.rounds.find((round) => round.round === 2);
    expect(roundTwo?.trace).toContain(`${rogue.display.judgeName} ${planted.value} (set aside)`);
    expect(roundTwo?.scores.find((cell) => cell.assignmentId === rogue.id)).toMatchObject({
      kept: false,
      status: "lopped",
      label: "set aside",
    });
    const totalBefore = debater.total ?? 0;

    // The team's two debaters are ranked; everyone else is still waiting for sheets.
    expect(new Set(view.ranking.rankedDebaters)).toEqual(new Set([first, second]));
    expect(view.ranking.unrankedDebaters).toHaveLength(6);
    const waiting = view.debaters.find((d) => d.id === view.ranking.unrankedDebaters[0].id);
    expect(waiting?.statusWords).toBe("can't be scored yet");
    expect(waiting?.reasons.some((line) => line.includes("has not been received"))).toBe(true);
    const ownTeam = view.teams.find((t) => t.id === team.id);
    expect(ownTeam).toMatchObject({ status: "ready", rank: 1 });
    expect(ownTeam?.members.map((m) => m.id).sort()).toEqual([first, second].sort());
    expect(view.completeness).toMatchObject({
      expected: 18,
      received: 9,
      provisional: true,
      finalizable: false,
    });
    expect(view.completeness.missing).toHaveLength(9);
    expect(view.completeness.missing[0]).toMatchObject({ waived: false });
    expect(view.completeness.missing[0].judgeName.length).toBeGreaterThan(0);
    expect(view.completeness.missing[0].roomName.length).toBeGreaterThan(0);
    expect(view.finalists.resolved).toBe(false);
    expect(view.openConflicts).toBe(0);

    const override = await addOverride(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      kind: "force_include",
      speakerId: first,
      assignmentId: rogue.id,
      reason: "The judge confirmed the score was deliberate.",
    });
    const restored = await divisionResults(db, drawn.tournamentId, "Open");
    expect(restored.setAside.some(isPlanted)).toBe(false);
    const after = restored.debaters.find((d) => d.id === first);
    const cell = after?.rounds
      .flatMap((round) => round.scores)
      .find((score) => score.assignmentId === rogue.id);
    expect(cell).toMatchObject({
      kept: true,
      status: "forced_in",
      label: "kept by the organiser",
      overrideId: override.id,
    });
    expect(after?.total).not.toBe(totalBefore);
    expect(after?.overrides.map((o) => o.kind)).toEqual(["force_include"]);
  });

  it("takes a debater out of the ranking without touching the others", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db, "exclude");
    const ctx = testContext(db);
    const team = drawn.schedule.teams.find((t) => t.divisionCode === "Novice");
    if (!team) throw new Error("no Novice team");
    const [first, second] = team.speakers.map((speaker) => speaker.id);
    for (const sheet of sheetsOfTeam(drawn, team.id))
      await simulateAndSubmit(ctx, drawn, sheet, "exclude");

    await addOverride(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Novice",
      kind: "exclude_debater",
      speakerId: second,
      reason: "Withdrew after round 2 for a school commitment.",
    });
    const view = await divisionResults(db, drawn.tournamentId, "Novice");
    const excluded = view.debaters.find((d) => d.id === second);
    expect(excluded).toMatchObject({ status: "unresolved", rank: null });
    expect(excluded?.reasons[0]).toContain("Set aside from the ranking by the organiser");
    const partner = view.debaters.find((d) => d.id === first);
    expect(partner).toMatchObject({ status: "ready", rank: 1 });
    expect(view.ranking.rankedDebaters).toEqual([first]);
    const ownTeam = view.teams.find((t) => t.id === team.id);
    expect(ownTeam?.status).toBe("incomplete");
    expect(ownTeam?.statusWords).toBe("fewer than two debaters");
    expect(view.completeness.blockers.some((line) => line.includes(team.name))).toBe(true);
  });

  it("scores a published division under the policy stamped on it", async () => {
    const db = await getDb();
    const drawn = await seedDrawn(db, "policy");
    const ctx = testContext(db, { log: silentLogger });
    const open = drawn.assignments.filter((a) => a.identity.divisionCode === "Open");
    for (const sheet of open) await simulateAndSubmit(ctx, drawn, sheet, "policy");

    const before = await divisionResults(db, drawn.tournamentId, "Open");
    expect(before.completeness.finalizable, before.completeness.blockers.join("\n")).toBe(true);
    expect(before.finalists.teams).toHaveLength(2);
    await finalizeDivision(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      acknowledgePolicy: true,
    });

    const looser = {
      ...WORKBOOK_POLICY,
      sdMultiplier: 0.5,
      whenUndefined: "keepAll",
      zeroSpread: "keepAll",
    };
    await db
      .update(tournaments)
      .set({ scoringPolicy: looser })
      .where(eq(tournaments.id, drawn.tournamentId));

    const published = await divisionResults(db, drawn.tournamentId, "Open");
    expect(published.policy).toEqual(WORKBOOK_POLICY);
    expect(published.debaters.map((d) => [d.id, d.total])).toEqual(
      before.debaters.map((d) => [d.id, d.total]),
    );
    expect(published.published?.by).toBe("Test runner");

    const novice = await divisionResults(db, drawn.tournamentId, "Novice");
    expect(novice.policy).toEqual(parseScoringPolicy(looser));

    await reopenDivision(ctx, {
      tournamentId: drawn.tournamentId,
      divisionCode: "Open",
      reason: "Checking the policy change.",
    });
    const reopened = await divisionResults(db, drawn.tournamentId, "Open");
    expect(reopened.policy).toEqual(parseScoringPolicy(looser));
    expect(reopened.published).toBeNull();
  });

  it("parseScoringPolicy refuses a corrupt policy as an internal error", () => {
    expect(() => parseScoringPolicy({ sdMultiplier: "two" })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(parseScoringPolicy({ ...WORKBOOK_POLICY })).toEqual(WORKBOOK_POLICY);
  });
});
