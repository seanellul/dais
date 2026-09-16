import { randomInt, type RandomSource } from "./prng";

/**
 * Fisher-Yates shuffle. Returns a new array; the input is not changed.
 * Every permutation is equally likely when the source is uniform.
 */
export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInt(random, index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
