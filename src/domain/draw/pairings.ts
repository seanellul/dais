/**
 * Opponent pairings by the circle method.
 *
 * Teams sit in a ring. Each round pairs the first with the last, the second
 * with the second-last, and so on. Between rounds the last team moves to
 * position 1 while position 0 stays fixed. For an even number of teams n this
 * gives n - 1 rounds in which no team meets the same opponent twice.
 */

/** Two team ids that meet in one debate, before sides are chosen. */
export type Pair = [string, string];

/** The most rounds a division of this size can play without a repeat opponent. */
export function maxRoundsWithoutRepeat(teamCount: number): number {
  return Math.max(0, teamCount - 1);
}

/**
 * Pairs an even number of team ids for the given number of rounds.
 * The order of `teamIds` decides the draw, so shuffle or seed it first.
 */
export function roundPairings(teamIds: readonly string[], rounds: number): Pair[][] {
  const ring = [...teamIds];
  const half = Math.floor(ring.length / 2);
  const result: Pair[][] = [];
  for (let round = 0; round < rounds; round += 1) {
    const pairs: Pair[] = [];
    for (let index = 0; index < half; index += 1) {
      pairs.push([ring[index], ring[ring.length - 1 - index]]);
    }
    result.push(pairs);
    const last = ring.pop();
    if (last !== undefined) ring.splice(1, 0, last);
  }
  return result;
}
