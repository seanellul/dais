import { randomInt, type RandomSource } from "./prng";

/**
 * Human-readable draw seeds, e.g. "2026-K7PM".
 *
 * The tail uses the Crockford base32 alphabet, which leaves out I, L, O and U
 * so a seed read aloud or copied from a projector is hard to get wrong.
 */
export const SEED_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The shape of a generated seed: four-digit year, a dash, four characters. */
export const SEED_PATTERN = /^\d{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export interface GenerateSeedOptions {
  /** The year prefix. Defaults to the current year. */
  year?: number;
  /** The random source. Defaults to Math.random; the seed itself is public. */
  random?: RandomSource;
}

/** Makes a new seed such as "2026-K7PM". */
export function generateSeed(options: GenerateSeedOptions = {}): string {
  const year = options.year ?? new Date().getFullYear();
  const random = options.random ?? Math.random;
  let tail = "";
  for (let index = 0; index < 4; index += 1) {
    tail += SEED_ALPHABET[randomInt(random, SEED_ALPHABET.length)];
  }
  return `${year}-${tail}`;
}

/**
 * Trims and upper-cases a seed typed by an organiser, so "2026-k7pm " and
 * "2026-K7PM" reproduce the same draw.
 */
export function normaliseSeed(text: string): string {
  return text.trim().toUpperCase();
}

/** True when the seed looks like a generated one. Any non-empty seed still works. */
export function isWellFormedSeed(text: string): boolean {
  return SEED_PATTERN.test(normaliseSeed(text));
}
