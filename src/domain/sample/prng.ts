/**
 * A tiny seeded random number generator (mulberry32) so sample data and
 * simulated sheets are reproducible from a seed. It is not for security.
 *
 * Seeds may be strings; they are hashed with sha256 so "conyers-2027" and
 * "conyers-2028" give unrelated streams.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/** The first 32 bits of sha256(text) as an unsigned integer. */
export function hash32(text: string): number {
  const digest = sha256(utf8ToBytes(text));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

/** A stable number in [0, 1) derived from text. Same text, same number. */
export function hashToUnit(text: string): number {
  return hash32(text) / 4294967296;
}

export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** A whole number in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A new array in random order (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
  /** Normally distributed (Box-Muller). */
  gaussian(mean: number, sd: number): number;
}

export function createRng(seed: string | number): Rng {
  let state = typeof seed === "number" ? seed >>> 0 : hash32(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      return items[Math.floor(next() * items.length)];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    gaussian(mean, sd) {
      // Box-Muller: two uniforms in (0, 1] make one standard normal.
      const u = 1 - next();
      const v = next();
      const standard = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + sd * standard;
    },
  };
}
