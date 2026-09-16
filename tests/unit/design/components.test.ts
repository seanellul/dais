/**
 * Logic inside the Dais components that a contrast check cannot see:
 * class merging, band lookup, score parsing and range messages, progress
 * clamping, theme parsing and the polite announcement queue.
 *
 * Nothing here renders React; each module exports the pure part it relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RubricBand } from "@/domain/types";
import { cn as shadcnCn } from "@/lib/utils";
import { findBand, sortBands } from "@/ui/band-bar";
import { cn, TYPE_SCALE } from "@/ui/cn";
import { cleanDigits, parseNumber, rangeError } from "@/ui/number-field";
import { createPoliteQueue, POLITE_BATCH_MS } from "@/ui/polite-queue";
import { clampProgress } from "@/ui/progress-strip";
import { parseColourTheme, readColourThemeFromCookies, THEME_COOKIE } from "@/ui/theme";

describe("cn (class merging that knows the type scale)", () => {
  it("is the same cn the shadcn components use", () => {
    expect(shadcnCn).toBe(cn);
  });

  it("keeps a custom size next to a colour", () => {
    expect(cn("text-h3 text-text")).toBe("text-h3 text-text");
    expect(cn("text-caption text-text-secondary")).toBe("text-caption text-text-secondary");
  });

  it.each(TYPE_SCALE)("treats text-%s as a font size", (step) => {
    // A later custom size replaces Tailwind's own size, and the reverse.
    expect(cn(`text-sm text-${step}`)).toBe(`text-${step}`);
    expect(cn(`text-${step} text-sm`)).toBe("text-sm");
  });

  it("lets a later size replace an earlier one without touching the colour", () => {
    expect(cn("text-primary-foreground text-sm", "text-on-action text-body-lg")).toBe(
      "text-on-action text-body-lg",
    );
  });

  it("treats elevation-* as one group", () => {
    expect(cn("elevation-1", "elevation-0")).toBe("elevation-0");
  });

  it("still merges ordinary utilities", () => {
    expect(cn("h-8 px-2", "h-14")).toBe("px-2 h-14");
    expect(cn("p-4", undefined, false, "p-2")).toBe("p-2");
  });
});

const BANDS: RubricBand[] = [
  { min: 90, max: 103, label: "Excellent", summary: "" },
  { min: 70, max: 79, label: "Good", summary: "" },
  { min: 80, max: 89, label: "Very good", summary: "" },
  { min: 0, max: 59, label: "Needs work", summary: "" },
  // 60 to 69 is deliberately missing.
];

describe("sortBands and findBand", () => {
  it("sorts bands from lowest to highest without changing the input", () => {
    const sorted = sortBands(BANDS);
    expect(sorted.map((band) => band.min)).toEqual([0, 70, 80, 90]);
    expect(BANDS[0].min).toBe(90);
  });

  it("finds the band at both edges", () => {
    expect(findBand(BANDS, 80)?.band.label).toBe("Very good");
    expect(findBand(BANDS, 89)?.band.label).toBe("Very good");
    expect(findBand(BANDS, 90)?.band.label).toBe("Excellent");
    expect(findBand(BANDS, 103)?.band.label).toBe("Excellent");
    expect(findBand(BANDS, 0)?.band.label).toBe("Needs work");
  });

  it("reports the band's position in the sorted list", () => {
    expect(findBand(BANDS, 75)?.index).toBe(1);
    expect(findBand(BANDS, 95)?.index).toBe(3);
  });

  it("returns null in a gap, out of range, for no value and for no bands", () => {
    expect(findBand(BANDS, 65)).toBeNull();
    expect(findBand(BANDS, 104)).toBeNull();
    expect(findBand(BANDS, -1)).toBeNull();
    expect(findBand(BANDS, null)).toBeNull();
    expect(findBand(BANDS, Number.NaN)).toBeNull();
    expect(findBand([], 50)).toBeNull();
  });
});

describe("cleanDigits and parseNumber", () => {
  it("keeps digits only for whole numbers", () => {
    expect(cleanDigits("12.", false)).toBe("12");
    expect(cleanDigits("-3", false)).toBe("3");
    expect(cleanDigits("1a2b", false)).toBe("12");
    expect(cleanDigits("", false)).toBe("");
  });

  it("keeps one decimal point when decimals are allowed", () => {
    expect(cleanDigits("12.", true)).toBe("12.");
    expect(cleanDigits("1.2.3", true)).toBe("1.23");
    expect(cleanDigits(".5", true)).toBe(".5");
    expect(cleanDigits("-3.5", true)).toBe("3.5");
  });

  it("parses cleaned text, treating empty and a lone point as no value", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber(".")).toBeNull();
    expect(parseNumber("12.")).toBe(12);
    expect(parseNumber("0")).toBe(0);
    expect(parseNumber("1.25")).toBe(1.25);
  });
});

describe("rangeError", () => {
  it("says nothing for an empty or in-range value", () => {
    expect(rangeError(null, 0, 33)).toBeNull();
    expect(rangeError(0, 0, 33)).toBeNull();
    expect(rangeError(33, 0, 33)).toBeNull();
    expect(rangeError(500)).toBeNull();
  });

  it("names both limits when both are set", () => {
    expect(rangeError(40, 0, 33)).toBe("Enter a whole number from 0 to 33.");
    expect(rangeError(-1, 0, 33)).toBe("Enter a whole number from 0 to 33.");
  });

  it("names one limit when only one is set", () => {
    expect(rangeError(-1, 0)).toBe("Enter a whole number of at least 0.");
    expect(rangeError(104, undefined, 103)).toBe("Enter a whole number of at most 103.");
  });

  it("drops 'whole' when decimals are allowed", () => {
    expect(rangeError(33.5, 0, 33, true)).toBe("Enter a number from 0 to 33.");
  });
});

describe("clampProgress", () => {
  it("holds the value inside 0 and max", () => {
    expect(clampProgress(2, 4)).toEqual({ value: 2, max: 4, percent: 50 });
    expect(clampProgress(6, 4)).toEqual({ value: 4, max: 4, percent: 100 });
    expect(clampProgress(-2, 4)).toEqual({ value: 0, max: 4, percent: 0 });
  });

  it("never divides by zero", () => {
    expect(clampProgress(0, 0)).toEqual({ value: 0, max: 0, percent: 0 });
    expect(clampProgress(3, -1)).toEqual({ value: 0, max: 0, percent: 0 });
  });

  it("rounds to a whole percentage", () => {
    expect(clampProgress(1, 3).percent).toBe(33);
    expect(clampProgress(2, 3).percent).toBe(67);
  });
});

describe("colour theme parsing", () => {
  it("accepts only the known themes", () => {
    expect(parseColourTheme("esu")).toBe("esu");
    expect(parseColourTheme("neutral")).toBe("neutral");
    expect(parseColourTheme("ESU")).toBe("neutral");
    expect(parseColourTheme(undefined)).toBe("neutral");
    expect(parseColourTheme(null)).toBe("neutral");
  });

  it("reads the theme cookie from a cookie store", () => {
    const store = (value?: string) => ({
      get: (name: string) => (name === THEME_COOKIE && value ? { value } : undefined),
    });
    expect(readColourThemeFromCookies(store("esu"))).toBe("esu");
    expect(readColourThemeFromCookies(store("other"))).toBe("neutral");
    expect(readColourThemeFromCookies(store())).toBe("neutral");
  });
});

describe("createPoliteQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the first message at once", () => {
    const flushed: string[] = [];
    const queue = createPoliteQueue((text) => flushed.push(text));
    queue.push("Sheet received from Room 4");
    expect(flushed).toEqual(["Sheet received from Room 4"]);
  });

  it("batches messages that arrive within the gap into one sentence", () => {
    const flushed: string[] = [];
    const queue = createPoliteQueue((text) => flushed.push(text));
    queue.push("Room 1 received");
    vi.advanceTimersByTime(1000);
    queue.push("Room 2 received");
    vi.advanceTimersByTime(500);
    queue.push("Room 3 received");
    expect(flushed).toHaveLength(1);

    vi.advanceTimersByTime(POLITE_BATCH_MS - 1500);
    expect(flushed).toEqual(["Room 1 received", "Room 2 received. Room 3 received"]);
  });

  it("reads a message straight away once the gap has passed", () => {
    const flushed: string[] = [];
    const queue = createPoliteQueue((text) => flushed.push(text), 3000);
    queue.push("first");
    vi.advanceTimersByTime(3000);
    queue.push("second");
    expect(flushed).toEqual(["first", "second"]);
  });

  it("drops a pending batch on cancel", () => {
    const flushed: string[] = [];
    const queue = createPoliteQueue((text) => flushed.push(text));
    queue.push("first");
    queue.push("never read");
    queue.cancel();
    vi.advanceTimersByTime(POLITE_BATCH_MS * 2);
    expect(flushed).toEqual(["first"]);
  });
});
