import { describe, expect, it } from "vitest";
import { createRng, hash32, hashToUnit } from "@/domain/sample/prng";

describe("createRng", () => {
  it("gives the same stream for the same seed", () => {
    const a = createRng("conyers-2027");
    const b = createRng("conyers-2027");
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it("gives different streams for different seeds", () => {
    expect(createRng("a").next()).not.toBe(createRng("b").next());
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it("stays in range", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const whole = rng.int(-3, 3);
      expect(whole).toBeGreaterThanOrEqual(-3);
      expect(whole).toBeLessThanOrEqual(3);
      expect(Number.isInteger(whole)).toBe(true);
    }
  });

  it("shuffles into a permutation without touching the input", () => {
    const rng = createRng("shuffle");
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(shuffled).not.toEqual(items);
  });

  it("draws roughly normal numbers", () => {
    const rng = createRng("gauss");
    const samples = Array.from({ length: 4000 }, () => rng.gaussian(50, 3));
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    expect(Math.abs(mean - 50)).toBeLessThan(0.3);
  });

  it("hashes text to a stable 32-bit number and unit interval", () => {
    expect(hash32("spk-o01-1")).toBe(hash32("spk-o01-1"));
    expect(hash32("spk-o01-1")).not.toBe(hash32("spk-o01-2"));
    const unit = hashToUnit("anything");
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(unit).toBeLessThan(1);
  });
});
