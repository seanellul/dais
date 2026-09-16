import type { Pair } from "./pairings";

/**
 * Which team takes Government in each pairing.
 *
 * Goal: over the tournament every team debates on each side at least once.
 * Two steps give that guarantee for the common three-round day:
 *
 * 1. The first two rounds (in priority order) are balanced exactly. Their
 *    pairings together form even cycles, so the teams can be split into two
 *    groups where every pairing joins one team from each group. Group A takes
 *    Government in the first round and Opposition in the second; group B does
 *    the reverse. Every team is then Government exactly once.
 * 2. Every later round uses the prototype's greedy rule: the team that has
 *    been Government fewer times takes Government; ties alternate by position.
 *
 * Pass `priority` to balance the rounds whose sides are decided in advance
 * first; rounds decided by a coin toss in the room come last. Any round the
 * priority leaves out is appended in index order, and repeats and indexes
 * outside the rounds are dropped, so every round is always sided.
 */

/** A pairing with sides chosen. */
export interface SidedPair {
  governmentTeamId: string;
  oppositionTeamId: string;
}

export function orientPairings(
  rounds: readonly Pair[][],
  priority: readonly number[] = rounds.map((_, index) => index),
): SidedPair[][] {
  const order = asPermutation(priority, rounds.length);
  const governmentCount = new Map<string, number>();
  const sided: SidedPair[][] = rounds.map(() => []);

  const [first, second, ...rest] = order;
  let remaining = order;
  if (first !== undefined && second !== undefined) {
    const group = splitIntoTwoGroups(rounds[first], rounds[second]);
    sided[first] = rounds[first].map((pair) => sideBy(pair, (id) => group.get(id) === 0));
    sided[second] = rounds[second].map((pair) => sideBy(pair, (id) => group.get(id) === 1));
    for (const round of [sided[first], sided[second]]) {
      for (const pair of round) countGovernment(governmentCount, pair.governmentTeamId);
    }
    remaining = rest;
  }

  for (const roundIndex of remaining) {
    sided[roundIndex] = rounds[roundIndex].map(([left, right], pairIndex) => {
      const leftCount = governmentCount.get(left) ?? 0;
      const rightCount = governmentCount.get(right) ?? 0;
      const leftGovernment =
        leftCount < rightCount || (leftCount === rightCount && (roundIndex + pairIndex) % 2 === 0);
      const pair = leftGovernment
        ? { governmentTeamId: left, oppositionTeamId: right }
        : { governmentTeamId: right, oppositionTeamId: left };
      countGovernment(governmentCount, pair.governmentTeamId);
      return pair;
    });
  }
  return sided;
}

/**
 * Turns a priority list into a permutation of 0..count-1: keeps the first
 * appearance of each valid index, then appends the indexes it left out.
 */
function asPermutation(priority: readonly number[], count: number): number[] {
  const valid = priority.filter((index) => Number.isInteger(index) && index >= 0 && index < count);
  const missing = Array.from({ length: count }, (_, index) => index);
  return [...new Set([...valid, ...missing])];
}

function sideBy(pair: Pair, isGovernment: (teamId: string) => boolean): SidedPair {
  const [left, right] = pair;
  return isGovernment(left)
    ? { governmentTeamId: left, oppositionTeamId: right }
    : { governmentTeamId: right, oppositionTeamId: left };
}

function countGovernment(counts: Map<string, number>, teamId: string): void {
  counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
}

/**
 * Colours the teams 0 or 1 so that every pairing in either round joins a 0
 * with a 1. The union of two rounds is a set of even cycles, so this always
 * succeeds. Walks teams in the order they appear, for a deterministic result.
 */
function splitIntoTwoGroups(roundA: readonly Pair[], roundB: readonly Pair[]): Map<string, 0 | 1> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const [left, right] of roundA) link(left, right);
  for (const [left, right] of roundB) link(left, right);

  const group = new Map<string, 0 | 1>();
  for (const [start] of roundA) {
    if (group.has(start)) continue;
    group.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift() as string;
      const colour = group.get(current) as 0 | 1;
      for (const next of neighbours.get(current) ?? []) {
        if (group.has(next)) continue;
        group.set(next, colour === 0 ? 1 : 0);
        queue.push(next);
      }
    }
  }
  return group;
}
