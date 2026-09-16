/**
 * Deterministic pseudo-random numbers for the draw.
 *
 * A draw must be reproducible: anyone with the seed and the team list can
 * regenerate it exactly. So the draw never calls Math.random. It uses
 * mulberry32, a small and well-known 32-bit generator, seeded from the seed
 * text through a simple hash.
 *
 * This is not a cryptographic generator. Draw seeds are public by design.
 */

/** A function that returns a float in [0, 1), like Math.random. */
export type RandomSource = () => number;

/**
 * Hashes any text to a 32-bit unsigned integer (FNV-1a over UTF-16 code
 * units). Small changes to the text give very different numbers.
 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a generator of floats in [0, 1) from one 32-bit seed. */
export function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded from text. The same text always gives the same sequence. */
export function createRandom(seedText: string): RandomSource {
  return mulberry32(hashSeed(seedText));
}

/** An integer in [0, max) drawn from the source. */
export function randomInt(random: RandomSource, max: number): number {
  return Math.floor(random() * max);
}
