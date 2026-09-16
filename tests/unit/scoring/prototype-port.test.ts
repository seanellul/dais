/**
 * The eleven cases from the prototype's scoring.test.mjs, with the same
 * expected numbers. Three things are deliberately different in the new engine
 * and are called out where they appear:
 *
 * - reason codes are renamed and more specific (`insufficient-data` →
 *   `sd_undefined`, `zero-spread` → `zero_spread`, and a round with no
 *   scores at all is `no_scores` rather than `no-retained-scores`);
 * - a missing sheet no longer removes every rank: the numbers still show,
 *   marked provisional, and publishing is held back;
 * - teams are keyed by id, not by name.
 */

import { describe, expect, it } from "vitest";
import { computeDivisionResults, rankEq } from "@/domain/scoring";
import { BLUE, DEBATERS, RED, division, roundsFor, scoreRounds } from "./helpers";

describe("scoreDebater (ported scoreStudent cases)", () => {
  it("computes all-round sample statistics and sums retained round averages", () => {
    const result = scoreRounds([
      [10, 20],
      [20, 30],
      [30, 40],
    ]);
    expect(result.mean).toBe(25);
    expect(result.sd).toBe(Math.sqrt(110));
    expect(result.lower).toBe(25 - 2 * Math.sqrt(110));
    expect(result.upper).toBe(25 + 2 * Math.sqrt(110));
    expect(result.rounds).toEqual([
      { average: 15, retained: [10, 20], excluded: [], status: "ready" },
      { average: 25, retained: [20, 30], excluded: [], status: "ready" },
      { average: 35, retained: [30, 40], excluded: [], status: "ready" },
    ]);
    expect(result.total).toBe(75);
    expect(result.status).toBe("ready");
  });

  it("filters each round once using strict global bounds", () => {
    const result = scoreRounds([[-3], [-3], [-3, -3, -8, 20]]);
    expect(result.mean).toBe(0);
    expect(result.sd).toBe(10);
    expect(result.upper).toBe(20);
    expect(result.rounds[2].retained).toEqual([-3, -3, -8]);
    expect(result.rounds[2].excluded).toEqual([20]);
    expect(result.rounds[2].average).toBe(-14 / 3);
    expect(Math.abs((result.total ?? Number.NaN) - -32 / 3)).toBeLessThan(1e-12);
    // The new engine also says why: the 20 sits exactly on the upper edge.
    const twenty = result.result.rounds[2].sources.find((s) => s.value === 20);
    expect(twenty?.status).toBe("lopped");
    expect(twenty?.onBoundary).toBe("upper");
  });

  it("ignores missing and nonfinite scores and exposes unresolved cases", () => {
    const result = scoreRounds([[1, null, Number.NaN], [3, undefined], [Number.POSITIVE_INFINITY]]);
    expect(result.mean).toBe(2);
    expect(result.sd).toBe(Math.SQRT2);
    expect(result.status).toBe("unresolved");
    expect(result.reason).toBe("no_scores"); // was 'no-retained-scores'
    expect(result.total).toBeNull();
    expect(result.rounds[2].status).toBe("unresolved");
    expect(result.rounds[2].average).toBeNull();
    expect(result.rounds[2].retained).toEqual([]);
  });

  it("explains empty and single-score statistics", () => {
    expect(scoreRounds([[], [], []]).reason).toBe("no_scores"); // was 'insufficient-data': with nothing at all, each round says so
    expect(scoreRounds([[9], [], []]).reason).toBe("sd_undefined");
  });

  it("marks zero spread and empty retained rounds unresolved", () => {
    const zeroSpread = scoreRounds([[7], [7], [7]]);
    expect(zeroSpread.sd).toBe(0);
    expect(zeroSpread.status).toBe("unresolved");
    expect(zeroSpread.reason).toBe("zero_spread"); // was 'zero-spread'
    expect(zeroSpread.total).toBeNull();

    const emptyRound = scoreRounds([[0, 0], [0, 10], []]);
    expect(emptyRound.rounds[2].status).toBe("unresolved");
    expect(emptyRound.reason).toBe("no_scores"); // was 'no-retained-scores'
    expect(emptyRound.total).toBeNull();
  });

  it("excludes an outlier-only round while retaining the one-pass value", () => {
    const result = scoreRounds([
      [0, 0],
      [0, 0],
      [0, 0, 0, 10, 100],
    ]);
    expect(result.rounds[2].retained).toEqual([0, 0, 0, 10]);
    expect(result.rounds[2].excluded).toEqual([100]);
    expect(result.status).toBe("ready");
  });

  it("applies strict lower and upper boundaries at shifted exact thresholds", () => {
    const upper = scoreRounds([[47], [47], [47, 47, 42, 70]]);
    const lower = scoreRounds([[53], [53], [53, 53, 58, 30]]);
    expect(upper.upper).toBe(70);
    expect(upper.rounds[2].excluded).toEqual([70]);
    expect(lower.lower).toBe(30);
    expect(lower.rounds[2].excluded).toEqual([30]);
  });
});

describe("rankEq (ported rankDescending)", () => {
  it("uses descending RANK.EQ ties", () => {
    expect(rankEq([100, 80, 80, 50])).toEqual([1, 2, 2, 4]);
  });
});

describe("computeDivisionResults (ported buildResults cases)", () => {
  const twoDebaters = {
    debaters: DEBATERS.filter((d) => d.id === "a" || d.id === "c"),
    teams: [
      { ...RED, debaterIds: ["a"] },
      { ...BLUE, debaterIds: ["c"] },
    ],
    overrides: [
      {
        id: "ov-red",
        kind: "rank_single_speaker_team" as const,
        teamId: RED.id,
        reason: "one debater",
      },
      {
        id: "ov-blue",
        kind: "rank_single_speaker_team" as const,
        teamId: BLUE.id,
        reason: "one debater",
      },
    ],
  };

  it("aggregates three rounds, ranks debaters and teams, and preserves unresolved state", () => {
    const input = division(roundsFor({ a: [10, 20, 30], c: [20, 10, 20] }), twoDebaters);
    const result = computeDivisionResults(input);

    expect(result.completeness.provisional).toBe(false);
    expect(result.completeness.finalizable).toBe(true);
    expect(
      result.debaters.map(({ id, total, rank, status }) => ({ id, total, rank, status })),
    ).toEqual([
      { id: "a", total: 60, rank: 1, status: "ready" },
      { id: "c", total: 50, rank: 2, status: "ready" },
    ]);
    const firstSource = result.debaters[0].rounds[0].sources[0];
    expect(firstSource).toMatchObject({
      assignmentId: "asg-r1-judge-1",
      value: 10,
      status: "retained",
    });
    expect(
      result.teams.map(({ id, total, rank, status }) => ({ id, total, rank, status })),
    ).toEqual([
      { id: RED.id, total: 60, rank: 1, status: "ready" },
      { id: BLUE.id, total: 50, rank: 2, status: "ready" },
    ]);

    const missingRound = division(
      [
        { round: 1, scores: { a: 10, c: 20 } },
        { round: 2, scores: null, debaterIds: ["a", "c"] },
        { round: 3, scores: { a: 30, c: 20 } },
      ],
      twoDebaters,
    );
    const missing = computeDivisionResults(missingRound);
    expect(missing.completeness.provisional).toBe(true);
    expect(missing.completeness.finalizable).toBe(false);
    expect(missing.debaters[0].rank).toBeNull();
    expect(missing.debaters[0].status).toBe("unresolved");
    expect(missing.debaters[0].rounds[1]).toMatchObject({
      status: "missing",
      reason: "sheet_missing",
    });
  });

  it("treats one missing judge sheet as incomplete even when other judges submitted", () => {
    const input = division(
      [
        { round: 1, judgeId: "j1", scores: { a: 10 } },
        { round: 1, judgeId: "j2", scores: null, debaterIds: ["a"] },
        { round: 2, scores: { a: 20 } },
        { round: 3, scores: { a: 30 } },
      ],
      {
        ...twoDebaters,
        debaters: DEBATERS.filter((d) => d.id === "a"),
        teams: [{ ...RED, debaterIds: ["a"] }],
      },
    );
    const result = computeDivisionResults(input);
    expect(result.completeness.provisional).toBe(false === result.completeness.finalizable);
    expect(result.completeness.finalizable).toBe(false);
    expect(result.completeness.missing).toEqual([
      {
        assignmentId: "asg-r1-j2",
        judgeName: "Judge j2",
        round: 1,
        roomName: "Room 1",
        waived: false,
      },
    ]);
    // Deliberate delta: the prototype nulled the rank here. Dais keeps the
    // partial number visible, marked provisional, and holds back publishing.
    expect(result.debaters[0].rank).toBe(1);
    expect(result.debaters[0].provisional).toBe(true);
    expect(result.teams[0].provisional).toBe(true);
  });

  it("pairs two debaters per team and preserves tied team ranks", () => {
    const input = division(
      roundsFor({ a: [10, 20, 30], b: [10, 20, 30], c: [10, 20, 30], d: [10, 20, 30] }),
    );
    const result = computeDivisionResults(input);
    expect(result.completeness.finalizable).toBe(true);
    expect(result.teams.map(({ id, total, rank }) => ({ id, total, rank }))).toEqual([
      { id: RED.id, total: 120, rank: 1 },
      { id: BLUE.id, total: 120, rank: 1 },
    ]);
    expect(result.ties).toContainEqual({ scope: "team", rank: 1, ids: [RED.id, BLUE.id] });
  });
});
