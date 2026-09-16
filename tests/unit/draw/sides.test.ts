import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { orientPairings, roundPairings } from "@/domain/draw";

const teamIds = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const evenTeamCount = fc.integer({ min: 2, max: 20 }).map((half) => half * 2);

function governmentCounts(
  rounds: ReturnType<typeof orientPairings>,
  roundIndexes?: number[],
): Map<string, number> {
  const counts = new Map<string, number>();
  rounds.forEach((pairs, index) => {
    if (roundIndexes && !roundIndexes.includes(index)) return;
    for (const pair of pairs)
      counts.set(pair.governmentTeamId, (counts.get(pair.governmentTeamId) ?? 0) + 1);
  });
  return counts;
}

describe("orientPairings", () => {
  it("keeps each pairing's two teams and puts one on each side", () => {
    fc.assert(
      fc.property(evenTeamCount, (n) => {
        const pairs = roundPairings(teamIds(n), 3);
        const sided = orientPairings(pairs);
        sided.forEach((round, r) => {
          round.forEach((pair, i) => {
            expect([pair.governmentTeamId, pair.oppositionTeamId].sort()).toEqual(
              [...pairs[r][i]].sort(),
            );
          });
        });
      }),
      { numRuns: 40 },
    );
  });

  it("gives every team Government one or two times over three rounds, for n = 4..40", () => {
    fc.assert(
      fc.property(evenTeamCount, (n) => {
        const sided = orientPairings(roundPairings(teamIds(n), 3));
        const counts = governmentCounts(sided);
        for (const id of teamIds(n)) {
          const count = counts.get(id) ?? 0;
          expect(count).toBeGreaterThanOrEqual(1);
          expect(count).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("balances the two priority rounds exactly, whichever rounds they are", () => {
    fc.assert(
      fc.property(
        evenTeamCount,
        fc.constantFrom([0, 1, 2], [1, 2, 0], [2, 0, 1]),
        (n, priority) => {
          const sided = orientPairings(roundPairings(teamIds(n), 3), priority);
          const counts = governmentCounts(sided, priority.slice(0, 2));
          for (const id of teamIds(n)) expect(counts.get(id) ?? 0).toBe(1);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("sides every round when the priority is partial, repeats an index or lists a bad one", () => {
    const pairs = roundPairings(teamIds(8), 3);
    const full = orientPairings(pairs, [0, 1, 2]);
    expect(orientPairings(pairs, [0, 1])).toEqual(full);
    expect(orientPairings(pairs, [0, 1, 1, 0])).toEqual(full);
    expect(orientPairings(pairs, [7, -1, 0.5])).toEqual(full);
    for (const sided of [orientPairings(pairs, [2]), orientPairings(pairs, [])]) {
      expect(sided.map((round) => round.length)).toEqual([4, 4, 4]);
    }
  });

  it("uses the greedy rule for a single round", () => {
    const sided = orientPairings(roundPairings(teamIds(6), 1));
    expect(sided[0]).toHaveLength(3);
    expect(governmentCounts(sided).size).toBe(3);
  });

  it("is deterministic", () => {
    const pairs = roundPairings(teamIds(12), 3);
    expect(orientPairings(pairs)).toEqual(orientPairings(pairs));
  });
});
