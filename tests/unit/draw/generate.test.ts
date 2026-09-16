import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { countRepeatRoomVisits, debateId, generateDraw } from "@/domain/draw";
import { validateSchedule } from "@/domain/schedule";
import type { Debate, Schedule } from "@/domain/types";
import {
  THREE_ROUNDS,
  buildSchedule,
  drawnSchedule,
  sampleJudge,
  sampleTeam,
} from "./build-schedule";

const evenTeamCount = fc.integer({ min: 2, max: 20 }).map((half) => half * 2);
/** Any seed text an organiser could type; a blank seed is refused, so it is tested on its own. */
const seedText = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((text) => text.trim().length > 0);

function draw(
  schedule: Schedule,
  divisionCodes: string[],
  seed = "2026-TEST",
  extra = {},
): Debate[] {
  const result = generateDraw({ schedule, divisionCodes, seed, method: "random", ...extra });
  if (!result.ok) throw new Error(result.error.message);
  return result.debates;
}

const pairKey = (debate: Debate) =>
  [debate.governmentTeamId, debate.oppositionTeamId].sort().join(":");

/** The invariants every draw must keep, checked per division. */
function expectSoundDraw(schedule: Schedule, debates: Debate[], divisionCode: string): void {
  const teams = schedule.teams.filter((team) => team.divisionCode === divisionCode);
  const own = debates.filter((debate) => debate.divisionCode === divisionCode);
  const rounds = schedule.settings.rounds.map((round) => round.number);
  const met = new Set<string>();
  const government = new Map<string, number>();
  const governmentInAdvance = new Map<string, number>();
  for (const round of rounds) {
    const inRound = own.filter((debate) => debate.round === round);
    expect(inRound).toHaveLength(teams.length / 2);
    const appearances = inRound.flatMap((debate) => [
      debate.governmentTeamId,
      debate.oppositionTeamId,
    ]);
    expect(new Set(appearances).size).toBe(teams.length);
    for (const debate of inRound) {
      expect(met.has(pairKey(debate))).toBe(false);
      met.add(pairKey(debate));
      government.set(debate.governmentTeamId, (government.get(debate.governmentTeamId) ?? 0) + 1);
      if (schedule.settings.rounds.find((r) => r.number === round)?.sidesDecided === "in-advance") {
        governmentInAdvance.set(
          debate.governmentTeamId,
          (governmentInAdvance.get(debate.governmentTeamId) ?? 0) + 1,
        );
      }
    }
  }
  for (const team of teams) {
    expect(government.get(team.id) ?? 0).toBeGreaterThanOrEqual(1);
    expect(government.get(team.id) ?? 0).toBeLessThanOrEqual(2);
    expect(governmentInAdvance.get(team.id) ?? 0).toBe(1);
  }
}

/** Rooms and judges are shared: one debate per room per round, one panel per judge per round. */
function expectNoDoubleBooking(debates: Debate[]): void {
  for (const round of new Set(debates.map((debate) => debate.round))) {
    const inRound = debates.filter((debate) => debate.round === round);
    expect(new Set(inRound.map((debate) => debate.roomId)).size).toBe(inRound.length);
    const judges = inRound.flatMap((debate) => debate.judgeIds);
    expect(new Set(judges).size).toBe(judges.length);
  }
}

describe("generateDraw: one division", () => {
  it("draws a sound three-round schedule for n = 4..40 teams", () => {
    fc.assert(
      fc.property(evenTeamCount, seedText, (n, seed) => {
        const schedule = buildSchedule({ open: n, rooms: n / 2, judgesPerRoom: 2 });
        const debates = draw(schedule, ["Open"], seed);
        expectSoundDraw(schedule, debates, "Open");
        expectNoDoubleBooking(debates);
        expect(validateSchedule({ ...schedule, debates }, { requireComplete: true })).toEqual({
          ok: true,
        });
      }),
      { numRuns: 40 },
    );
  });

  it("gives the same draw for the same seed, whatever its case or spacing", () => {
    const schedule = buildSchedule({ open: 20 });
    const first = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "2026-K7PM",
      method: "random",
    });
    const second = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: " 2026-k7pm",
      method: "random",
    });
    expect(first).toEqual(second);
    expect(first.ok && first.seed).toBe("2026-K7PM");
  });

  it("gives a different order for a different seed", () => {
    const schedule = buildSchedule({ open: 20 });
    const a = draw(schedule, ["Open"], "2026-AAAA")
      .filter((d) => d.round === 1)
      .map(pairKey);
    const b = draw(schedule, ["Open"], "2026-BBBB")
      .filter((d) => d.round === 1)
      .map(pairKey);
    expect(a).not.toEqual(b);
  });

  it("sends twenty teams to three different rooms across ten rooms", () => {
    const schedule = drawnSchedule({ open: 20, rooms: 10 });
    expect(countRepeatRoomVisits(schedule.debates)).toBe(0);
  });

  it("keeps fixed-room judges in their room for every round", () => {
    const schedule = drawnSchedule({ open: 20, rooms: 10, judgesPerRoom: 3 });
    for (const judge of schedule.judges) {
      const rooms = new Set(
        schedule.debates.filter((d) => d.judgeIds.includes(judge.id)).map((d) => d.roomId),
      );
      expect(rooms.size).toBe(1);
      expect([...rooms][0]).toBe(judge.homeRoomId);
    }
    expect(schedule.debates.every((debate) => debate.judgeIds.length === 3)).toBe(true);
  });

  it("orders by seed number for the seeded method: seed 1 meets seed n in round 1", () => {
    const schedule = buildSchedule({ open: 12, rooms: 6 });
    const result = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "2026-SEED",
      method: "seeded",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.debates.find((d) => d.round === 1 && d.id.endsWith("-d1"));
    expect(first).toBeDefined();
    const ids = [first?.governmentTeamId, first?.oppositionTeamId].sort();
    expect(ids).toEqual([sampleTeam("Open", 1).id, sampleTeam("Open", 12).id].sort());
    expect(result.warnings).toEqual([]);
  });

  it("warns when the seeded method meets teams without a seed number", () => {
    const schedule = buildSchedule({ open: 8, rooms: 4 });
    schedule.teams[2].seed = null;
    const result = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "2026-SEED",
      method: "seeded",
    });
    expect(result.ok && result.warnings).toEqual([
      "1 team in Open has no seed number and was placed after the seeded teams, by team code.",
    ]);
  });

  it("uses readable, deterministic debate ids", () => {
    expect(debateId("Open", 1, 0)).toBe("debate-open-r1-d1");
    expect(debateId("Year 7 & 8", 3, 4)).toBe("debate-year-7-8-r3-d5");
    const debates = draw(buildSchedule({ open: 8, rooms: 4 }), ["Open"]);
    expect(new Set(debates.map((debate) => debate.id)).size).toBe(debates.length);
    expect(debates.every((debate) => debate.motion === "")).toBe(true);
  });

  it("ignores withdrawn teams", () => {
    const schedule = buildSchedule({ open: 10, rooms: 5 });
    schedule.teams[0].status = "withdrawn";
    schedule.teams[1].status = "withdrawn";
    const debates = draw(schedule, ["Open"]);
    const ids = new Set(debates.flatMap((d) => [d.governmentTeamId, d.oppositionTeamId]));
    expect(ids.has(schedule.teams[0].id)).toBe(false);
    expect(debates.filter((d) => d.round === 1)).toHaveLength(4);
  });
});

describe("generateDraw: reproducibility", () => {
  /** "1 room-01 O05 v O01 judge-01,judge-06": one line per debate. */
  const lines = (schedule: Schedule, debates: Debate[]) => {
    const codes = new Map(schedule.teams.map((team) => [team.id, team.code]));
    return debates.map(
      (d) =>
        `${d.round} ${d.roomId} ${codes.get(d.governmentTeamId)} v ${codes.get(d.oppositionTeamId)} ${d.judgeIds.join(",")}`,
    );
  };

  it("reproduces a pinned draw exactly, in code-unit order whatever the host locale", () => {
    // A lower-case team code and reserve judges named "Åke", "ben" and "Ben"
    // sort differently under localeCompare on almost every locale; the draw
    // must order them by code unit (uppercase, then lowercase, then "Å").
    const schedule = buildSchedule({ open: 6, rooms: 3, judges: 3, judgesPerRoom: 1 });
    schedule.teams[1].code = "o02";
    schedule.judges.push(
      { ...sampleJudge(4), name: "Åke Judge" },
      { ...sampleJudge(5), name: "ben Judge" },
      { ...sampleJudge(6), name: "Ben Judge" },
    );
    const result = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "2026-GOLD",
      method: "random",
      judgesPerRoom: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(lines(schedule, result.debates)).toEqual([
      "1 room-01 O05 v O01 judge-01,judge-06",
      "1 room-02 o02 v O04 judge-02,judge-05",
      "1 room-03 O06 v O03 judge-03,judge-04",
      "2 room-01 O04 v O05 judge-01,judge-06",
      "2 room-02 O01 v O06 judge-02,judge-05",
      "2 room-03 O03 v o02 judge-03,judge-04",
      "3 room-01 O05 v O06 judge-01,judge-06",
      "3 room-02 O03 v O04 judge-02,judge-05",
      "3 room-03 O01 v o02 judge-03,judge-04",
    ]);
  });

  it("gives a division the same opponents and sides alone or with other divisions, in any order", () => {
    const schedule = buildSchedule({ open: 12, novice: 8, rooms: 10 });
    const matchups = (debates: Debate[]) =>
      debates
        .filter((d) => d.divisionCode === "Novice")
        .map((d) => `${d.round}:${d.governmentTeamId}>${d.oppositionTeamId}`);
    const alone = matchups(draw(schedule, ["Novice"]));
    expect(matchups(draw(schedule, ["Open", "Novice"]))).toEqual(alone);
    expect(matchups(draw(schedule, ["Novice", "Open"]))).toEqual(alone);
  });

  it("draws divisions in settings order, so the order requested does not change rooms either", () => {
    const schedule = buildSchedule({ open: 12, novice: 8, rooms: 10 });
    expect(draw(schedule, ["Novice", "Open"])).toEqual(draw(schedule, ["Open", "Novice"]));
  });
});

describe("generateDraw: two divisions drawn together", () => {
  it("shares one room pool and one judge pool without double booking", () => {
    const schedule = buildSchedule({ open: 12, novice: 8, rooms: 10, judgesPerRoom: 2 });
    const debates = draw(schedule, ["Open", "Novice"]);
    expectSoundDraw(schedule, debates, "Open");
    expectSoundDraw(schedule, debates, "Novice");
    expectNoDoubleBooking(debates);
    expect(validateSchedule({ ...schedule, debates }, { requireComplete: true })).toEqual({
      ok: true,
    });
    const openRooms = new Set(
      debates.filter((d) => d.divisionCode === "Open").map((d) => d.roomId),
    );
    const noviceRooms = new Set(
      debates.filter((d) => d.divisionCode === "Novice").map((d) => d.roomId),
    );
    expect([...openRooms].some((room) => noviceRooms.has(room))).toBe(false);
  });

  it("holds the sharing property for many sizes", () => {
    const half = fc.integer({ min: 2, max: 10 });
    fc.assert(
      fc.property(half, half, (openHalf, noviceHalf) => {
        const schedule = buildSchedule({
          open: openHalf * 2,
          novice: noviceHalf * 2,
          rooms: openHalf + noviceHalf,
          judgesPerRoom: 1,
        });
        const debates = draw(schedule, ["Open", "Novice"], `seed-${openHalf}-${noviceHalf}`);
        expectSoundDraw(schedule, debates, "Open");
        expectSoundDraw(schedule, debates, "Novice");
        expectNoDoubleBooking(debates);
      }),
      { numRuns: 25 },
    );
  });

  it("leaves another division's debates untouched and avoids its rooms and judges", () => {
    const schedule = buildSchedule({ open: 12, novice: 8, rooms: 10, judgesPerRoom: 2 });
    const openOnly = draw(schedule, ["Open"]);
    const withOpen = { ...schedule, debates: openOnly };
    const both = draw(withOpen, ["Novice"], "2026-NOVI");
    expect(both.filter((d) => d.divisionCode === "Open")).toEqual(openOnly);
    const openRooms = new Set(openOnly.map((d) => d.roomId));
    const openJudges = new Set(openOnly.flatMap((d) => d.judgeIds));
    for (const debate of both.filter((d) => d.divisionCode === "Novice")) {
      expect(openRooms.has(debate.roomId)).toBe(false);
      expect(debate.judgeIds.some((id) => openJudges.has(id))).toBe(false);
    }
    expectNoDoubleBooking(both);
  });
});

describe("generateDraw: per-round panels", () => {
  it("never seats a judge twice in a round and shows each judge different rooms", () => {
    const schedule = buildSchedule({
      open: 20,
      rooms: 10,
      judges: 20,
      judgesPerRoom: 2,
      panelMode: "per-round",
    });
    const debates = draw(schedule, ["Open"]);
    expectNoDoubleBooking(debates);
    expect(debates.every((debate) => debate.judgeIds.length === 2)).toBe(true);
    for (const judge of schedule.judges) {
      const rooms = debates.filter((d) => d.judgeIds.includes(judge.id)).map((d) => d.roomId);
      expect(rooms).toHaveLength(3);
      expect(new Set(rooms).size).toBe(3);
    }
    expect(validateSchedule({ ...schedule, debates }, { requireComplete: true })).toEqual({
      ok: true,
    });
  });

  it("rests spare judges in turn and warns when panels are short", () => {
    const plenty = buildSchedule({
      open: 8,
      rooms: 4,
      judges: 10,
      judgesPerRoom: 2,
      panelMode: "per-round",
    });
    const result = generateDraw({
      schedule: plenty,
      divisionCodes: ["Open"],
      seed: "x",
      method: "random",
    });
    expect(result.ok && result.warnings).toEqual([]);
    const few = buildSchedule({
      open: 8,
      rooms: 4,
      judges: 5,
      judgesPerRoom: 2,
      panelMode: "per-round",
    });
    const short = generateDraw({
      schedule: few,
      divisionCodes: ["Open"],
      seed: "x",
      method: "random",
    });
    expect(short.ok && short.warnings[0]).toBe(
      "Round 1 has 5 judges for 4 rooms; 2 per room needs 8. 3 panels are short.",
    );
    expect(short.ok && short.debates.every((debate) => debate.judgeIds.length >= 1)).toBe(true);
  });
});

describe("generateDraw: fixed-room panels", () => {
  it("tops up short panels from unallocated judges, who then follow that room", () => {
    const schedule = buildSchedule({ open: 8, rooms: 4, judges: 4, judgesPerRoom: 1 });
    schedule.judges.push(sampleJudge(5), sampleJudge(6), sampleJudge(7), sampleJudge(8));
    const result = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "x",
      method: "random",
      judgesPerRoom: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.debates.every((debate) => debate.judgeIds.length === 2)).toBe(true);
    for (const judge of schedule.judges) {
      const rooms = new Set(
        result.debates.filter((d) => d.judgeIds.includes(judge.id)).map((d) => d.roomId),
      );
      expect(rooms.size).toBe(1);
    }
  });

  it("warns about rooms with no judges and rooms below the wanted panel size", () => {
    const schedule = buildSchedule({ open: 8, rooms: 4, judges: 3, judgesPerRoom: 1 });
    const result = generateDraw({
      schedule,
      divisionCodes: ["Open"],
      seed: "x",
      method: "random",
      judgesPerRoom: 2,
    });
    expect(result.ok && result.warnings).toEqual([
      "Room 1 has 1 judge; the tournament wants 2 per room.",
      "Room 2 has 1 judge; the tournament wants 2 per room.",
      "Room 3 has 1 judge; the tournament wants 2 per room.",
      "Room 4 has no judges yet.",
    ]);
  });

  it("prefers rooms that already have a panel", () => {
    const schedule = buildSchedule({
      open: 8,
      rooms: 6,
      judges: 8,
      judgesPerRoom: 2,
      allocateJudges: false,
    });
    for (const [index, judge] of schedule.judges.entries())
      judge.homeRoomId = schedule.rooms[2 + Math.floor(index / 2)].id;
    const debates = draw(schedule, ["Open"]);
    expect(new Set(debates.map((d) => d.roomId))).toEqual(
      new Set(schedule.rooms.slice(2).map((room) => room.id)),
    );
  });
});

describe("generateDraw: refusals", () => {
  const attempt = (schedule: Schedule, divisionCodes = ["Open"], extra = {}) =>
    generateDraw({ schedule, divisionCodes, seed: "2026-TEST", method: "random", ...extra });

  it("needs a seed", () => {
    const result = attempt(buildSchedule({ open: 8, rooms: 4 }), ["Open"], { seed: "  " });
    expect(result).toEqual({
      ok: false,
      error: { code: "seed-missing", message: "Enter a seed for the draw, or generate one." },
    });
  });

  it("needs at least one known division", () => {
    expect(attempt(buildSchedule(), [])).toEqual({
      ok: false,
      error: { code: "no-divisions", message: "Choose at least one division to draw." },
    });
    expect(attempt(buildSchedule(), ["Intermediate"])).toEqual({
      ok: false,
      error: {
        code: "unknown-division",
        message: '"Intermediate" is not one of the tournament\'s divisions.',
      },
    });
  });

  it("refuses fewer than four teams", () => {
    expect(attempt(buildSchedule({ open: 2 }))).toEqual({
      ok: false,
      error: { code: "too-few-teams", message: "Open has 2 teams; a draw needs at least four." },
    });
  });

  it("refuses an odd number of teams", () => {
    expect(attempt(buildSchedule({ open: 7 }))).toEqual({
      ok: false,
      error: {
        code: "odd-team-count",
        message: "Add one more team so Open has an even number of teams.",
      },
    });
  });

  it("refuses more rounds than the teams allow without a repeat opponent", () => {
    const fourRounds = [
      ...THREE_ROUNDS,
      { number: 4, format: "impromptu" as const, sidesDecided: "in-room" as const },
    ];
    expect(attempt(buildSchedule({ open: 4, rooms: 2, rounds: fourRounds }))).toEqual({
      ok: false,
      error: {
        code: "too-many-rounds",
        message: "Open has 4 teams, which allows at most 3 rounds without a repeat opponent.",
      },
    });
  });

  it("refuses when the shared pool has too few rooms", () => {
    expect(attempt(buildSchedule({ open: 12, novice: 8, rooms: 8 }), ["Open", "Novice"])).toEqual({
      ok: false,
      error: {
        code: "not-enough-rooms",
        message:
          "Each round needs 10 rooms at once (6 for Open and 4 for Novice); only 8 rooms are free.",
      },
    });
  });

  it("refuses when the tournament has no rounds", () => {
    expect(attempt(buildSchedule({ open: 8, rooms: 4, rounds: [] }))).toEqual({
      ok: false,
      error: { code: "no-rounds", message: "Add at least one round in Settings before drawing." },
    });
  });
});
