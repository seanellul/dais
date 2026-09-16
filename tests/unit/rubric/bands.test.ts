import { describe, expect, it } from "vitest";
import { bandFor, categoryBandFor, categoryBands } from "@/domain/rubric/bands";
import { DEFAULT_BANDS } from "@/domain/settings";

const label = (value: number) => bandFor(value, DEFAULT_BANDS)?.label ?? null;

describe("bandFor", () => {
  it("maps each boundary of the Overall score to the guide's band", () => {
    expect(label(103)).toBe("Excellent");
    expect(label(87)).toBe("Excellent");
    expect(label(86)).toBe("Very good");
    expect(label(81)).toBe("Very good");
    expect(label(80)).toBe("Competent");
    expect(label(71)).toBe("Competent");
    expect(label(70)).toBe("Fair");
    expect(label(66)).toBe("Fair");
    expect(label(65)).toBe("Ineffective");
    expect(label(40)).toBe("Ineffective");
    expect(label(39)).toBe("Below the rubric's range");
    expect(label(0)).toBe("Below the rubric's range");
  });

  it("returns null outside every band", () => {
    expect(label(104)).toBeNull();
    expect(label(-1)).toBeNull();
    expect(label(Number.NaN)).toBeNull();
  });

  it("carries the guide's summary text", () => {
    expect(bandFor(84, DEFAULT_BANDS)?.summary).toBe("Solid and polished; did what they had to do");
  });
});

describe("categoryBands", () => {
  it("scales the /103 floors to /33 the way the guide does", () => {
    const scaled = categoryBands(33, DEFAULT_BANDS).map((band) => [band.label, band.min, band.max]);
    expect(scaled).toEqual([
      ["Excellent", 29, 33],
      ["Very good", 27, 28],
      ["Competent", 24, 26],
      ["Fair", 22, 23],
      ["Ineffective", 13, 21],
      ["Below the rubric's range", 0, 12],
    ]);
  });

  it("scales to other category sizes without gaps", () => {
    const scaled = categoryBands(20, DEFAULT_BANDS).sort((a, b) => a.min - b.min);
    expect(scaled[0].min).toBe(0);
    expect(scaled[scaled.length - 1].max).toBe(20);
    for (let i = 1; i < scaled.length; i += 1) expect(scaled[i].min).toBe(scaled[i - 1].max + 1);
  });

  it("leaves out a band that has no room in a small category instead of squashing it", () => {
    const shape = (max: number) =>
      categoryBands(max, DEFAULT_BANDS).map((band) => [band.label, band.min, band.max]);
    expect(shape(10)).toEqual([
      ["Excellent", 9, 10],
      ["Very good", 8, 8],
      ["Competent", 7, 7],
      ["Ineffective", 4, 6],
      ["Below the rubric's range", 0, 3],
    ]);
    expect(shape(4)).toEqual([
      ["Excellent", 4, 4],
      ["Very good", 3, 3],
      ["Ineffective", 2, 2],
      ["Below the rubric's range", 0, 1],
    ]);
  });

  it("covers 0 to the maximum with no gaps or negative ranges for any category size", () => {
    for (let max = 1; max <= 40; max += 1) {
      const scaled = categoryBands(max, DEFAULT_BANDS).sort((a, b) => a.min - b.min);
      expect(scaled[0].min).toBe(0);
      expect(scaled[scaled.length - 1].max).toBe(max);
      for (const band of scaled) {
        expect(band.min).toBeGreaterThanOrEqual(0);
        expect(band.max).toBeGreaterThanOrEqual(band.min);
      }
      for (let i = 1; i < scaled.length; i += 1) expect(scaled[i].min).toBe(scaled[i - 1].max + 1);
    }
  });
});

describe("categoryBandFor", () => {
  const cat = (value: number) => categoryBandFor(value, 33, DEFAULT_BANDS)?.label ?? null;

  it("labels category scores at each boundary", () => {
    expect(cat(33)).toBe("Excellent");
    expect(cat(29)).toBe("Excellent");
    expect(cat(28)).toBe("Very good");
    expect(cat(27)).toBe("Very good");
    expect(cat(26)).toBe("Competent");
    expect(cat(24)).toBe("Competent");
    expect(cat(23)).toBe("Fair");
    expect(cat(22)).toBe("Fair");
    expect(cat(21)).toBe("Ineffective");
    expect(cat(13)).toBe("Ineffective");
    expect(cat(12)).toBe("Below the rubric's range");
  });

  it("returns null above the category maximum", () => {
    expect(cat(34)).toBeNull();
  });
});
