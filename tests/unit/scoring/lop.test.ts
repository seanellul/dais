/**
 * Setting scores aside under each policy knob: realistic panels, strict
 * versus inclusive edges, one pass versus iterative, pooled versus per-round
 * scope, the two edge cases, and the 15-digit rounding Excel applies.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_ITERATIVE_PASSES,
  WORKBOOK_POLICY,
  WORKBOOK_SAFE_POLICY,
  lopValues,
  type LopValue,
  type LoppingPolicy,
} from "@/domain/scoring";
import { scoreRounds } from "./helpers";

const values = (list: number[], prefix = "s"): LopValue[] =>
  list.map((value, index) => ({ value, sourceId: `${prefix}${index + 1}` }));

/** Three judges over three rounds, all plausible, plus one rogue 40 in round 3. */
const REALISTIC = [
  [78, 84, 81],
  [85, 79, 88],
  [90, 83, 40],
];

describe("lopValues", () => {
  it("keeps legitimate disagreement and sets aside a rogue 40", () => {
    const result = lopValues(values(REALISTIC.flat()), WORKBOOK_POLICY);
    expect(result.lopped).toEqual([{ sourceId: "s9", pass: 1 }]);
    expect(result.retained).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    expect(result.stats.n).toBe(9);
    expect(result.stats.lower).toBeGreaterThan(40);
    expect(result.stats.upper).toBeGreaterThan(90); // the 90 and the 78 both stay
    expect(result.reason).toBeUndefined();
  });

  it("strict edges set aside a score exactly on the line; inclusive edges keep it", () => {
    const exact = values([47, 47, 47, 47, 42, 70]); // mean 50, spread 10, upper edge 70
    const strict = lopValues(exact, WORKBOOK_POLICY);
    expect(strict.stats).toMatchObject({ mean: 50, sd: 10, lower: 30, upper: 70 });
    expect(strict.lopped).toEqual([{ sourceId: "s6", pass: 1, onBoundary: "upper" }]);

    const inclusive = lopValues(exact, { ...WORKBOOK_POLICY, bounds: "inclusive" });
    expect(inclusive.lopped).toEqual([]);
    expect(inclusive.retained).toHaveLength(6);

    const lower = lopValues(values([53, 53, 53, 53, 58, 30]), WORKBOOK_POLICY);
    expect(lower.lopped).toEqual([{ sourceId: "s6", pass: 1, onBoundary: "lower" }]);
  });

  it("iterative passes converge, stamp the pass number and keep the first-pass statistics", () => {
    const input = values([10, 10, 10, 10, 10, 10, 10, 10, 20, 100]);
    const onePass = lopValues(input, WORKBOOK_POLICY);
    expect(onePass.lopped).toEqual([{ sourceId: "s10", pass: 1 }]);
    expect(onePass.passStats).toHaveLength(1);

    const iterative = lopValues(input, { ...WORKBOOK_POLICY, passes: "iterative" });
    expect(iterative.lopped).toEqual([
      { sourceId: "s10", pass: 1 },
      { sourceId: "s9", pass: 2 },
    ]);
    expect(iterative.retained).toHaveLength(8);
    expect(iterative.passStats).toHaveLength(2);
    expect(iterative.stats).toEqual(onePass.stats); // the trace shows what the workbook would show
    expect(iterative.passStats[1].n).toBe(9);
    expect(iterative.passStats.length).toBeLessThanOrEqual(MAX_ITERATIVE_PASSES);
  });

  it("stops at the pass cap and records statistics only for the passes that ran", () => {
    // Four 10s and a doubling tail: every pass sets aside the largest value
    // left, so the loop would go on past the cap if nothing stopped it.
    const tail = Array.from({ length: 12 }, (_, index) => 10 * 2 ** (index + 1));
    const result = lopValues(values([10, 10, 10, 10, ...tail]), {
      ...WORKBOOK_POLICY,
      passes: "iterative",
    });
    const passes = result.lopped.map((item) => item.pass);
    expect(Math.max(...passes)).toBe(MAX_ITERATIVE_PASSES);
    expect(result.passStats).toHaveLength(MAX_ITERATIVE_PASSES);
    expect(result.lopped).toHaveLength(MAX_ITERATIVE_PASSES); // one per pass
    expect(result.retained).toHaveLength(6);
  });

  it("zero spread: the workbook policy keeps nothing, the safe policy keeps all", () => {
    const same = values([7, 7, 7]);
    const workbook = lopValues(same, WORKBOOK_POLICY);
    expect(workbook).toMatchObject({
      retained: [],
      reason: "zero_spread",
      edgeCase: "zero_spread",
    });
    expect(workbook.lopped).toEqual([
      { sourceId: "s1", pass: 1, onBoundary: "lower" },
      { sourceId: "s2", pass: 1, onBoundary: "lower" },
      { sourceId: "s3", pass: 1, onBoundary: "lower" },
    ]);
    expect(workbook.stats).toMatchObject({ n: 3, mean: 7, sd: 0, lower: 7, upper: 7 });

    const safe = lopValues(same, WORKBOOK_SAFE_POLICY);
    expect(safe).toMatchObject({
      retained: ["s1", "s2", "s3"],
      lopped: [],
      edgeCase: "zero_spread",
    });
    expect(safe.reason).toBeUndefined();
  });

  it("fewer than two scores: the workbook policy cannot decide, the safe policy keeps all", () => {
    const one = values([9]);
    expect(lopValues(one, WORKBOOK_POLICY)).toMatchObject({ retained: [], reason: "sd_undefined" });
    expect(lopValues(one, WORKBOOK_SAFE_POLICY)).toMatchObject({ retained: ["s1"], lopped: [] });
    expect(lopValues([], WORKBOOK_POLICY)).toMatchObject({
      retained: [],
      lopped: [],
      reason: "sd_undefined",
    });
    expect(lopValues([], WORKBOOK_SAFE_POLICY)).toMatchObject({ retained: [], lopped: [] });
    expect(lopValues(one, WORKBOOK_POLICY).stats).toEqual({
      n: 1,
      mean: 9,
      sd: null,
      lower: null,
      upper: null,
    });
  });

  it("rounds the kept range to 15 significant digits the way Excel builds its criteria", () => {
    // In exact arithmetic the upper edge is 87.1 and the sixth score sits on it.
    // In doubles the edge is 87.10000000000001, so without the rounding the
    // score slips inside; Excel writes "<87.1" and sets it aside.
    const noisy = values([61.8, 61.8, 61.8, 61.8, 56.3, 87.1]);
    const raw = lopValues(noisy, { ...WORKBOOK_POLICY, excelCriteriaRounding: false });
    expect(raw.stats.upper).not.toBe(87.1);
    expect(raw.lopped).toEqual([]);

    const excel = lopValues(noisy, WORKBOOK_POLICY);
    expect(excel.lopped).toEqual([{ sourceId: "s6", pass: 1, onBoundary: "upper" }]);

    // An edge that is exact in doubles is decided the same way either way.
    const exact = values([47, 47, 47, 47, 42, 70]);
    expect(lopValues(exact, { ...WORKBOOK_POLICY, excelCriteriaRounding: false }).lopped).toEqual(
      lopValues(exact, WORKBOOK_POLICY).lopped,
    );
  });

  it("honours the spread kind and the multiplier", () => {
    const three = values([10, 20, 30]);
    expect(lopValues(three, WORKBOOK_POLICY).stats).toMatchObject({ sd: 10, lower: 0, upper: 40 });
    const population = lopValues(three, { ...WORKBOOK_POLICY, sd: "population" });
    expect(population.stats.sd).toBeCloseTo(Math.sqrt(200 / 3), 12);
    expect(population.retained).toHaveLength(3);

    const tight: LoppingPolicy = { ...WORKBOOK_POLICY, sdMultiplier: 1 };
    const result = lopValues(three, tight);
    expect(result.stats).toMatchObject({ lower: 10, upper: 30 });
    expect(result.retained).toEqual(["s2"]);
    expect(result.lopped).toEqual([
      { sourceId: "s1", pass: 1, onBoundary: "lower" },
      { sourceId: "s3", pass: 1, onBoundary: "upper" },
    ]);
  });

  it("ignores non-finite values like blank cells", () => {
    const result = lopValues(
      [
        { value: Number.NaN, sourceId: "blank" },
        { value: 5, sourceId: "a" },
        { value: 6, sourceId: "b" },
      ],
      WORKBOOK_POLICY,
    );
    expect(result.stats.n).toBe(2);
    expect(result.retained).toEqual(["a", "b"]);
  });
});

describe("scoreDebater scope", () => {
  it("pooled scope sets the rogue 40 aside; per-round scope with three judges cannot", () => {
    const pooled = scoreRounds(REALISTIC);
    expect(pooled.rounds[2].excluded).toEqual([40]);
    expect(pooled.rounds[2].average).toBe((90 + 83) / 2);
    expect(pooled.result.stats.scope).toBe("pooled");

    // With n scores, the largest possible distance from the average is
    // (n − 1) / sqrt(n) spreads: under 2 for n < 6. A lone rogue score in a
    // room of up to five judges is never set aside under a per-round policy.
    const perRound = scoreRounds(REALISTIC, { ...WORKBOOK_POLICY, scope: "perRound" });
    expect(perRound.rounds[2].excluded).toEqual([]);
    expect(perRound.rounds[2].average).toBe((90 + 83 + 40) / 3);
    expect(perRound.result.stats.scope).toBe("perRound");
    if (perRound.result.stats.scope === "perRound") {
      expect(Object.keys(perRound.result.stats.byRound)).toEqual(["1", "2", "3"]);
      expect(perRound.result.stats.byRound[3].n).toBe(3);
      expect(perRound.result.stats.byRound[3].passStats).toHaveLength(1);
    }
  });

  it("per-round scope with one judge per room can't be scored under the workbook policy", () => {
    const perRound: LoppingPolicy = { ...WORKBOOK_POLICY, scope: "perRound" };
    const strict = scoreRounds([[80], [82], [79]], perRound);
    expect(strict.status).toBe("unresolved");
    expect(strict.result.rounds.map((r) => r.reason)).toEqual([
      "sd_undefined",
      "sd_undefined",
      "sd_undefined",
    ]);
    expect(strict.result.reasons).toEqual([
      "Round 1: fewer than two scores, so there is no spread to check.",
      "Round 2: fewer than two scores, so there is no spread to check.",
      "Round 3: fewer than two scores, so there is no spread to check.",
    ]);

    const safe = scoreRounds([[80], [82], [79]], { ...perRound, whenUndefined: "keepAll" });
    expect(safe).toMatchObject({ status: "ready", total: 241 });
  });

  it("stamps the pass number on each set-aside score under an iterative policy", () => {
    const iterative: LoppingPolicy = { ...WORKBOOK_POLICY, passes: "iterative" };
    const result = scoreRounds(
      [
        [10, 10, 10],
        [10, 10, 10],
        [10, 10, 20, 100],
      ],
      iterative,
    );
    const round3 = result.result.rounds[2].sources;
    expect(round3.map((s) => [s.value, s.status, s.pass])).toEqual([
      [10, "retained", undefined],
      [10, "retained", undefined],
      [20, "lopped", 2],
      [100, "lopped", 1],
    ]);
    if (result.result.stats.scope === "pooled") {
      expect(result.result.stats.passStats).toHaveLength(2);
    }
  });
});
