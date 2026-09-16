import { describe, expect, it } from "vitest";
import {
  ABILITY_MAX,
  ABILITY_MIN,
  JUDGE_BIAS_MAX,
  judgeBias,
  latentAbility,
  OVERALL_CEILING,
  OVERALL_FLOOR,
  ROGUE_DELTA,
  simulateSheet,
} from "@/domain/sample/simulate";
import { parseSheetPayload } from "@/domain/sheet/schema";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { EBI_PHRASES, WWW_PHRASES } from "@/domain/sample/phrases";
import { computeDivisionResults, WORKBOOK_POLICY, type ScoreSource } from "@/domain/scoring";
import type { AssignmentDisplay } from "@/domain/types";
import { DISPLAY, SPEAKER_IDS } from "../sheet/fixtures";

const rubric = DEFAULT_SETTINGS.rubric;
const base = { assignmentDisplay: DISPLAY, rubric, judgeId: "judge-01" };

describe("simulateSheet", () => {
  it("is deterministic from the seed and differs across seeds", () => {
    const a = simulateSheet({ ...base, seed: "r1" });
    const b = simulateSheet({ ...base, seed: "r1" });
    const c = simulateSheet({ ...base, seed: "r2" });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("produces a valid sheet for exactly the debaters on the assignment", () => {
    const sheet = simulateSheet({ ...base, seed: "valid" });
    expect(Object.keys(sheet.scores).sort()).toEqual([...SPEAKER_IDS].sort());
    expect(parseSheetPayload(sheet, { rubric, speakerIds: SPEAKER_IDS }).ok).toBe(true);
    expect(sheet.sideFlipped).toBe(false);
    expect(sheet.roleSwaps).toEqual({});
  });

  it("keeps every score in range across many sheets", () => {
    for (let i = 0; i < 300; i += 1) {
      const sheet = simulateSheet({ ...base, seed: i, rogueChance: 0 });
      for (const score of Object.values(sheet.scores)) {
        expect(score.overall).toBeGreaterThanOrEqual(OVERALL_FLOOR);
        expect(score.overall).toBeLessThanOrEqual(OVERALL_CEILING);
        expect(Number.isInteger(score.overall)).toBe(true);
        for (const value of [score.argumentation, score.rebuttal, score.presentation]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(33);
          expect(Math.abs(value - (score.overall / 103) * 33)).toBeLessThanOrEqual(2.5);
        }
        expect(score.poi).toBeGreaterThanOrEqual(0);
        expect(score.poi).toBeLessThanOrEqual(4);
        expect(WWW_PHRASES).toContain(score.www);
        expect(EBI_PHRASES).toContain(score.ebi);
      }
    }
  });

  it("plants one rogue score of 18 points when asked", () => {
    const clean = simulateSheet({ ...base, seed: "rogue", rogueChance: 0 });
    const rogue = simulateSheet({ ...base, seed: "rogue", rogueChance: 1 });
    const changed = SPEAKER_IDS.filter(
      (id) => clean.scores[id].overall !== rogue.scores[id].overall,
    );
    expect(changed).toHaveLength(1);
    const [id] = changed;
    const delta = Math.abs(rogue.scores[id].overall - clean.scores[id].overall);
    expect(delta).toBe(ROGUE_DELTA);
    expect(rogue.scores[id]).toMatchObject({ argumentation: clean.scores[id].argumentation });
  });

  it("fires the rogue roughly as often as the chance says", () => {
    let rogues = 0;
    const runs = 500;
    for (let i = 0; i < runs; i += 1) {
      const clean = simulateSheet({ ...base, seed: `p${i}`, rogueChance: 0 });
      const maybe = simulateSheet({ ...base, seed: `p${i}`, rogueChance: 0.04 });
      if (SPEAKER_IDS.some((id) => clean.scores[id].overall !== maybe.scores[id].overall))
        rogues += 1;
    }
    expect(rogues).toBeGreaterThan(5);
    expect(rogues).toBeLessThan(50);
  });

  it("passes side flip and role swaps through", () => {
    const sheet = simulateSheet({
      ...base,
      seed: 1,
      sideFlipped: true,
      roleSwaps: { "team-o01": true },
    });
    expect(sheet.sideFlipped).toBe(true);
    expect(sheet.roleSwaps).toEqual({ "team-o01": true });
  });

  it("falls back to the judge's name for the bias when no id is given", () => {
    const byName = simulateSheet({ assignmentDisplay: DISPLAY, rubric, seed: 3 });
    const byId = simulateSheet({ ...base, seed: 3 });
    expect(byName).not.toEqual(byId);
  });
});

describe("plantRogue", () => {
  const clean = simulateSheet({ ...base, seed: "plant", rogueChance: 0 });

  it("moves only the named debater's Overall, by 18 points", () => {
    const planted = simulateSheet({
      ...base,
      seed: "plant",
      rogueChance: 0,
      plantRogue: { speakerId: "spk-o02-1" },
    });
    for (const id of SPEAKER_IDS) {
      if (id !== "spk-o02-1") expect(planted.scores[id]).toEqual(clean.scores[id]);
    }
    const delta = planted.scores["spk-o02-1"].overall - clean.scores["spk-o02-1"].overall;
    expect(Math.abs(delta)).toBe(ROGUE_DELTA);
  });

  it("replaces the chance roll, so the rest of the sheet is untouched", () => {
    const withChance = simulateSheet({
      ...base,
      seed: "plant",
      rogueChance: 1,
      plantRogue: { speakerId: "spk-o01-1" },
    });
    const withoutChance = simulateSheet({
      ...base,
      seed: "plant",
      rogueChance: 0,
      plantRogue: { speakerId: "spk-o01-1" },
    });
    expect(withChance).toEqual(withoutChance);
  });

  it("does nothing for a debater who is not on the sheet", () => {
    const planted = simulateSheet({
      ...base,
      seed: "plant",
      rogueChance: 0,
      plantRogue: { speakerId: "spk-elsewhere" },
    });
    expect(planted).toEqual(clean);
  });

  it("honours a signed custom delta", () => {
    const planted = simulateSheet({
      ...base,
      seed: "plant",
      plantRogue: { speakerId: "spk-o01-2", delta: -25 },
    });
    expect(planted.scores["spk-o01-2"].overall).toBe(clean.scores["spk-o01-2"].overall - 25);
  });

  it("moves down instead when up would pass the top of the rubric", () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const sheet = simulateSheet({ ...base, seed, rogueChance: 0 });
      const high = SPEAKER_IDS.find(
        (id) => sheet.scores[id].overall + ROGUE_DELTA > rubric.overallMax,
      );
      if (!high) continue;
      const planted = simulateSheet({ ...base, seed, plantRogue: { speakerId: high } });
      expect(planted.scores[high].overall).toBe(sheet.scores[high].overall - ROGUE_DELTA);
      return;
    }
    throw new Error("No sheet in 300 seeds had a score within 18 of the top.");
  });
});

/**
 * The reason the sample roster has three judges per room: a planted rogue
 * is set aside under the workbook rule only when the debater has enough
 * other scores. This runs the real scoring engine over simulated sheets.
 */
describe("a planted rogue under the workbook rule", () => {
  const ROUNDS = [1, 2, 3];

  /** The fixture debate with the first speaker replaced by the debater under test. */
  function roomDisplay(debaterId: string, judgeName: string): AssignmentDisplay {
    return {
      ...DISPLAY,
      judgeName,
      speakers: DISPLAY.speakers.map((speaker, index) =>
        index === 0 ? { ...speaker, id: debaterId } : speaker,
      ),
    };
  }

  /** One debater's scores over three rounds, the rogue planted on round 1, seat 1. */
  function scoresFor(seed: string, judgesPerRoom: number): ScoreSource[] {
    const debaterId = `spk-${seed}`;
    const sources: ScoreSource[] = [];
    for (const round of ROUNDS) {
      for (let seat = 1; seat <= judgesPerRoom; seat += 1) {
        const judgeId = `judge-${seed}-r${round}-${seat}`;
        const sheet = simulateSheet({
          seed: `${seed}-r${round}`,
          assignmentDisplay: roomDisplay(debaterId, judgeId),
          rubric,
          judgeId,
          rogueChance: 0,
          plantRogue: round === 1 && seat === 1 ? { speakerId: debaterId } : undefined,
        });
        sources.push({
          assignmentId: `asg-${round}-${seat}`,
          judgeId,
          judgeName: judgeId,
          round,
          debaterId,
          value: sheet.scores[debaterId].overall,
          sheetVersion: 1,
          source: "simulation",
        });
      }
    }
    return sources;
  }

  function rogueSetAside(sources: ScoreSource[]): boolean {
    const debaterId = sources[0].debaterId;
    const results = computeDivisionResults({
      divisionId: "Open",
      rounds: ROUNDS,
      debaters: [{ id: debaterId, name: "Debater Under Test", teamId: "team-t", position: 1 }],
      teams: [{ id: "team-t", code: "T01", name: "Test", school: "Test", debaterIds: [debaterId] }],
      expectedSheets: sources.map((source) => ({
        assignmentId: source.assignmentId,
        round: source.round,
        judgeId: source.judgeId,
        judgeName: source.judgeName,
        roomName: "Room 1",
        debaterIds: [debaterId],
        received: true,
      })),
      scores: sources,
      overrides: [],
      policy: WORKBOOK_POLICY,
      topN: 0,
    });
    const planted = results.debaters[0].rounds[0].sources.find(
      (source) => source.assignmentId === "asg-1-1",
    );
    return planted?.status === "lopped";
  }

  function setAsideRate(judgesPerRoom: number, seeds: number): number {
    let setAside = 0;
    for (let i = 0; i < seeds; i += 1) {
      if (rogueSetAside(scoresFor(`w${i}`, judgesPerRoom))) setAside += 1;
    }
    return setAside / seeds;
  }

  it("is set aside in most seeds with three judges per room", () => {
    expect(setAsideRate(3, 40)).toBeGreaterThanOrEqual(0.8);
  });

  it("is mostly kept with two judges per room, so the sample roster uses three", () => {
    expect(setAsideRate(2, 40)).toBeLessThan(0.5);
  });
});

describe("hidden ability and judge bias", () => {
  it("keeps ability between 62 and 92 and bias within 3 points", () => {
    for (let i = 0; i < 200; i += 1) {
      const ability = latentAbility(`spk-${i}`);
      expect(ability).toBeGreaterThanOrEqual(ABILITY_MIN);
      expect(ability).toBeLessThan(ABILITY_MAX);
      const bias = judgeBias(`judge-${i}`);
      expect(Math.abs(bias)).toBeLessThanOrEqual(JUDGE_BIAS_MAX);
    }
  });

  it("is fixed by the id", () => {
    expect(latentAbility("spk-o01-1")).toBe(latentAbility("spk-o01-1"));
    expect(latentAbility("spk-o01-1")).not.toBe(latentAbility("spk-o01-2"));
  });
});
