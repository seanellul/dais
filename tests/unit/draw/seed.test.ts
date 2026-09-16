import { describe, expect, it } from "vitest";
import {
  SEED_ALPHABET,
  SEED_PATTERN,
  createRandom,
  generateSeed,
  isWellFormedSeed,
  normaliseSeed,
} from "@/domain/draw";

describe("seed", () => {
  it("generates YEAR-XXXX from the Crockford alphabet", () => {
    const seed = generateSeed({ year: 2026, random: createRandom("fixture") });
    expect(seed).toMatch(SEED_PATTERN);
    expect(seed.startsWith("2026-")).toBe(true);
    for (const char of seed.slice(5)) expect(SEED_ALPHABET).toContain(char);
  });

  it("never uses the confusable letters I, L, O or U", () => {
    expect(SEED_ALPHABET).not.toMatch(/[ILOU]/);
    const random = createRandom("many");
    for (let i = 0; i < 200; i += 1)
      expect(generateSeed({ year: 2026, random })).not.toMatch(/[ILOU]/);
  });

  it("is reproducible for the same random source", () => {
    expect(generateSeed({ year: 2026, random: createRandom("x") })).toBe(
      generateSeed({ year: 2026, random: createRandom("x") }),
    );
  });

  it("normalises what an organiser types", () => {
    expect(normaliseSeed("  2026-k7pm ")).toBe("2026-K7PM");
    expect(isWellFormedSeed(" 2026-k7pm")).toBe(true);
    expect(isWellFormedSeed("hello")).toBe(false);
    expect(isWellFormedSeed("2026-K7PI")).toBe(false);
  });
});
