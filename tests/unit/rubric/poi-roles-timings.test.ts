import { describe, expect, it } from "vitest";
import { POI_BANDS, poiBandFor } from "@/domain/rubric/poi";
import {
  actualSide,
  positionOf,
  ROLE_KEYS,
  roleFor,
  roleLabel,
  sideOf,
} from "@/domain/rubric/roles";
import { IMPROMPTU_PREP_MINUTES, speakingOrder, totalMinutes } from "@/domain/rubric/timings";
import {
  GUIDE_BAND_LABELS,
  GUIDE_PENALTIES,
  GUIDE_TEXT,
  guideEntry,
  guideForCategory,
  JUDGE_REMINDERS,
  RARE_HIGH_SCORE_NOTE,
  SPEECH_CATEGORIES,
} from "@/domain/rubric/guide";
import { DEFAULT_SETTINGS } from "@/domain/settings";

describe("points of information", () => {
  it("labels 0 to 4 as the guide does", () => {
    expect(poiBandFor(0)?.label).toBe("Poor");
    expect(poiBandFor(1)?.label).toBe("Fair");
    expect(poiBandFor(2)?.label).toBe("Good");
    expect(poiBandFor(3)?.label).toBe("Good");
    expect(poiBandFor(4)?.label).toBe("Excellent");
    expect(poiBandFor(5)).toBeNull();
  });

  it("covers 0 to 4 without gaps", () => {
    const sorted = [...POI_BANDS].sort((a, b) => a.min - b.min);
    expect(sorted[0].min).toBe(0);
    expect(sorted[sorted.length - 1].max).toBe(4);
  });
});

describe("roles", () => {
  it("lists the roles in speaking order", () => {
    expect(ROLE_KEYS).toEqual(["pm", "lo", "gm", "om"]);
  });

  it("maps side and position to a role and back", () => {
    expect(roleFor("government", 1)).toBe("pm");
    expect(roleFor("government", 2)).toBe("gm");
    expect(roleFor("opposition", 1)).toBe("lo");
    expect(roleFor("opposition", 2)).toBe("om");
    for (const role of ROLE_KEYS) expect(roleFor(sideOf(role), positionOf(role))).toBe(role);
  });

  it("swaps the teammates' roles when asked", () => {
    expect(roleFor("government", 1, true)).toBe("gm");
    expect(roleFor("opposition", 2, true)).toBe("lo");
  });

  it("uses the tournament's labels", () => {
    expect(roleLabel("pm")).toBe("Prime Minister");
    expect(roleLabel("lo", { ...DEFAULT_SETTINGS.roles, lo: "First Opposition" })).toBe(
      "First Opposition",
    );
  });

  it("flips the side after a coin toss", () => {
    expect(actualSide("government", false)).toBe("government");
    expect(actualSide("government", true)).toBe("opposition");
    expect(actualSide("opposition", true)).toBe("government");
  });
});

describe("timings", () => {
  it("gives five speeches in order with the format's minutes", () => {
    const prepared = speakingOrder("prepared", DEFAULT_SETTINGS.timings);
    expect(prepared.map((slot) => [slot.key, slot.role, slot.minutes])).toEqual([
      ["pm", "pm", 5],
      ["lo", "lo", 7],
      ["gm", "gm", 7],
      ["om", "om", 7],
      ["reply", "pm", 2],
    ]);
    expect(prepared[4].label).toBe("Prime Minister reply");

    const impromptu = speakingOrder("impromptu", DEFAULT_SETTINGS.timings);
    expect(impromptu.map((slot) => slot.minutes)).toEqual([4, 5, 5, 5, 1]);
  });

  it("adds up the speaking time", () => {
    expect(totalMinutes("prepared", DEFAULT_SETTINGS.timings)).toBe(28);
    expect(totalMinutes("impromptu", DEFAULT_SETTINGS.timings)).toBe(20);
    expect(IMPROMPTU_PREP_MINUTES).toBe(15);
  });
});

describe("guide", () => {
  it("has an entry for every category in every band", () => {
    expect(GUIDE_TEXT).toHaveLength(SPEECH_CATEGORIES.length * GUIDE_BAND_LABELS.length);
    for (const category of SPEECH_CATEGORIES) {
      const entries = guideForCategory(category);
      expect(entries.map((entry) => entry.band)).toEqual(GUIDE_BAND_LABELS);
      for (const entry of entries) expect(entry.points.length).toBeGreaterThan(0);
    }
  });

  it("looks up one entry, or null for an unknown band", () => {
    expect(guideEntry("rebuttal", "Ineffective")?.points).toContain(
      "A debater who attempts no rebuttal scores 13",
    );
    expect(guideEntry("rebuttal", "Legendary")).toBeNull();
  });

  it("keeps the three reminders and the rarity note", () => {
    expect(JUDGE_REMINDERS).toHaveLength(3);
    expect(JUDGE_REMINDERS[0]).toContain("Prime Minister's reply");
    expect(JUDGE_REMINDERS[1]).toContain("two positives and two improvements");
    expect(JUDGE_REMINDERS[2]).toContain("Do not announce a winner");
    expect(RARE_HIGH_SCORE_NOTE).toContain("above 90");
  });

  it("lists the penalties with their point ranges", () => {
    expect(GUIDE_PENALTIES.map((p) => [p.min, p.max])).toEqual([
      [2, 3],
      [1, 5],
    ]);
  });
});
