import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { maxRoundsWithoutRepeat, roundPairings } from "@/domain/draw";

const teamIds = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const evenTeamCount = fc.integer({ min: 2, max: 20 }).map((half) => half * 2);

describe("roundPairings (circle method)", () => {
  it("pairs every team exactly once per round, with no repeat opponent, for n = 4..40", () => {
    fc.assert(
      fc.property(evenTeamCount, fc.integer({ min: 1, max: 3 }), (n, rounds) => {
        const ids = teamIds(n);
        const result = roundPairings(ids, rounds);
        expect(result).toHaveLength(rounds);
        const met = new Set<string>();
        for (const pairs of result) {
          expect(pairs).toHaveLength(n / 2);
          const seen = new Set(pairs.flat());
          expect(seen.size).toBe(n);
          for (const [a, b] of pairs) {
            const key = [a, b].sort().join(":");
            expect(met.has(key)).toBe(false);
            met.add(key);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("supports n - 1 rounds without a repeat opponent", () => {
    for (const n of [4, 6, 8, 12]) {
      const rounds = maxRoundsWithoutRepeat(n);
      const met = new Set<string>();
      for (const pairs of roundPairings(teamIds(n), rounds)) {
        for (const [a, b] of pairs) {
          const key = [a, b].sort().join(":");
          expect(met.has(key)).toBe(false);
          met.add(key);
        }
      }
      expect(met.size).toBe((n * (n - 1)) / 2);
    }
  });

  it("depends on the order of the team ids", () => {
    const forward = roundPairings(teamIds(8), 3);
    const backward = roundPairings([...teamIds(8)].reverse(), 3);
    expect(forward[0]).not.toEqual(backward[0]);
  });
});
