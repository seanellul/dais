import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createRandom, hashSeed, mulberry32, randomInt, shuffle } from "@/domain/draw";

const take = (seed: string, count: number) => {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => random());
};

describe("prng", () => {
  it("gives the same sequence for the same seed text", () => {
    expect(take("2026-K7PM", 20)).toEqual(take("2026-K7PM", 20));
  });

  it("gives a different sequence for a different seed text", () => {
    expect(take("2026-K7PM", 5)).not.toEqual(take("2026-K7PN", 5));
  });

  it("hashes text to a 32-bit unsigned integer", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const hash = hashSeed(text);
        return Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff && hash === hashSeed(text);
      }),
    );
  });

  it("stays inside [0, 1) for any seed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const random = mulberry32(seed);
        for (let i = 0; i < 50; i += 1) {
          const value = random();
          if (value < 0 || value >= 1) return false;
        }
        return true;
      }),
    );
  });

  it("draws integers inside [0, max)", () => {
    const random = createRandom("ints");
    for (let i = 0; i < 200; i += 1) {
      const value = randomInt(random, 7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });
});

describe("shuffle", () => {
  it("returns a permutation and leaves the input alone", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.string(), (items, seed) => {
        const before = [...items];
        const result = shuffle(items, createRandom(seed));
        expect(items).toEqual(before);
        expect([...result].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
    );
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(items, createRandom("a"))).toEqual(shuffle(items, createRandom("a")));
    expect(shuffle(items, createRandom("a"))).not.toEqual(shuffle(items, createRandom("b")));
  });
});
