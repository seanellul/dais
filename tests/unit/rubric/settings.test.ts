import { describe, expect, it } from "vitest";
import { bandsCover, DEFAULT_BANDS, DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";

describe("DEFAULT_SETTINGS", () => {
  it("is the Conyers preset", () => {
    expect(DEFAULT_SETTINGS.divisions.map((d) => d.code)).toEqual(["Open", "Novice"]);
    expect(DEFAULT_SETTINGS.rounds.map((r) => [r.format, r.sidesDecided])).toEqual([
      ["prepared", "in-advance"],
      ["prepared", "in-advance"],
      ["impromptu", "in-room"],
    ]);
    expect(DEFAULT_SETTINGS.rubric.categories.map((c) => c.max)).toEqual([33, 33, 33, 4]);
    expect(DEFAULT_SETTINGS.rubric.overallMax).toBe(103);
    expect(DEFAULT_SETTINGS.rubric.noRebuttalScore).toBe(13);
    expect(DEFAULT_SETTINGS.rubric.integersOnly).toBe(true);
    expect(DEFAULT_SETTINGS.rubric.commentMaxLength).toBe(4000);
    expect(DEFAULT_SETTINGS.timings.prepared).toEqual([5, 7, 7, 7, 2]);
    expect(DEFAULT_SETTINGS.timings.impromptu).toEqual([4, 5, 5, 5, 1]);
    expect(DEFAULT_SETTINGS.panelMode).toBe("fixed-room");
    expect(DEFAULT_SETTINGS.judgesPerRoom).toBe(3);
    expect(DEFAULT_SETTINGS.feedbackRequired).toBe(false);
  });

  it("has contiguous bands covering 0 to 103", () => {
    const sorted = [...DEFAULT_BANDS].sort((a, b) => a.min - b.min);
    expect(sorted[0].min).toBe(0);
    expect(sorted[sorted.length - 1].max).toBe(103);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].min).toBe(sorted[i - 1].max + 1);
    }
  });
});

describe("parseSettings", () => {
  it("round-trips the default settings through JSON", () => {
    const result = parseSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(DEFAULT_SETTINGS);
  });

  it("reports a path and a plain message for bad input", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.judgesPerRoom = 9;
    broken.divisions = [];
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain("judgesPerRoom");
      expect(result.errors.find((error) => error.path === "divisions")?.message).toBe(
        "At least one division is required.",
      );
    }
  });

  it("rejects a band whose lower bound is above its upper bound", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.bands[0] = { min: 90, max: 80, label: "Odd", summary: "" };
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("rubric.bands.0");
      expect(result.errors[0].message).toContain('"Odd"');
    }
  });

  it("rejects bands that leave a gap", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.bands[1] = { ...broken.rubric.bands[1], min: 82 };
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "rubric.bands",
          message: "The bands must run from 0 to 103 with no gaps or overlaps.",
        },
      ]);
    }
  });

  it("rejects bands that overlap", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.bands[1] = { ...broken.rubric.bands[1], max: 87 };
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe("rubric.bands");
  });

  it("rejects a top band that stops short of the Overall maximum", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.bands[0] = { ...broken.rubric.bands[0], max: 100 };
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe("rubric.bands");
  });

  it("rejects a no-rebuttal score above the Rebuttal maximum", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.noRebuttalScore = 34;
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "rubric.noRebuttalScore",
          message: "The score for no rebuttal must be between 0 and 33, the Rebuttal maximum.",
        },
      ]);
    }
  });

  it("checks coverage with bandsCover", () => {
    expect(bandsCover(DEFAULT_BANDS, 103)).toBe(true);
    expect(bandsCover(DEFAULT_BANDS, 100)).toBe(false);
    expect(bandsCover([], 103)).toBe(false);
    expect(bandsCover([{ min: 1, max: 103, label: "All", summary: "" }], 103)).toBe(false);
  });

  it("rejects a repeated rubric category", () => {
    const broken = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    broken.rubric.categories.push({ key: "poi", label: "Again", max: 4 });
    const result = parseSettings(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe("rubric.categories");
  });

  it("never throws on nonsense", () => {
    expect(parseSettings(null).ok).toBe(false);
    expect(parseSettings("text").ok).toBe(false);
    expect(parseSettings(undefined).ok).toBe(false);
  });
});
