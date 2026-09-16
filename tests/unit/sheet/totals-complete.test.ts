import { describe, expect, it } from "vitest";
import { categorySum, teamTotals } from "@/domain/sheet/totals";
import { completeness, feedbackGaps } from "@/domain/sheet/complete";
import type { SheetDraft } from "@/domain/sheet/draft";
import { DISPLAY, fullPayload, score, SPEAKER_IDS } from "./fixtures";

describe("teamTotals", () => {
  it("adds up the Overall scores per drawn side", () => {
    expect(teamTotals(fullPayload(), DISPLAY)).toEqual({ government: 160, opposition: 164 });
  });

  it("stays null for a side until both debaters have an Overall", () => {
    const draft: SheetDraft = {
      scores: {
        "spk-o01-1": { overall: 82 },
        "spk-o02-1": { overall: 80 },
        "spk-o02-2": { overall: 84 },
      },
    };
    expect(teamTotals(draft, DISPLAY)).toEqual({ government: null, opposition: 164 });
  });

  it("ignores category marks when the Overall is missing", () => {
    const draft: SheetDraft = {
      scores: { "spk-o01-1": { argumentation: 30, rebuttal: 30, presentation: 30, poi: 4 } },
    };
    expect(teamTotals(draft, DISPLAY).government).toBeNull();
  });

  it("is null for a side with no debaters", () => {
    expect(teamTotals(fullPayload(), { ...DISPLAY, speakers: [] })).toEqual({
      government: null,
      opposition: null,
    });
  });
});

describe("categorySum", () => {
  it("adds the four categories", () => {
    expect(categorySum(score(82))).toBe(26 + 25 + 27 + 3);
  });

  it("is null until every category is filled", () => {
    expect(categorySum({ argumentation: 26, rebuttal: 25 })).toBeNull();
  });
});

describe("completeness", () => {
  it("counts fully scored debaters and lists what is missing", () => {
    const draft: SheetDraft = {
      scores: {
        "spk-o01-1": score(82),
        "spk-o01-2": { argumentation: 26, rebuttal: 25, presentation: 27, poi: 3 },
        "spk-o02-1": { overall: Number.NaN },
      },
    };
    const result = completeness(draft, SPEAKER_IDS);
    expect(result.scored).toBe(1);
    expect(result.total).toBe(4);
    expect(result.missingFields).toContainEqual({ speakerId: "spk-o01-2", field: "overall" });
    expect(result.missingFields.filter((m) => m.speakerId === "spk-o02-1")).toHaveLength(5);
    expect(result.missingFields.filter((m) => m.speakerId === "spk-o02-2")).toHaveLength(5);
  });

  it("is complete for a full sheet", () => {
    expect(completeness(fullPayload(), SPEAKER_IDS)).toEqual({
      scored: 4,
      total: 4,
      missingFields: [],
    });
  });
});

describe("feedbackGaps", () => {
  it("lists empty or whitespace comments per debater", () => {
    const payload = fullPayload();
    payload.scores["spk-o01-1"].www = "   ";
    payload.scores["spk-o02-2"].ebi = "";
    expect(feedbackGaps(payload, SPEAKER_IDS)).toEqual([
      { speakerId: "spk-o01-1", field: "www" },
      { speakerId: "spk-o02-2", field: "ebi" },
    ]);
  });

  it("lists both fields for a debater with no draft yet", () => {
    expect(feedbackGaps({ scores: {} }, ["spk-o01-1"])).toEqual([
      { speakerId: "spk-o01-1", field: "www" },
      { speakerId: "spk-o01-1", field: "ebi" },
    ]);
  });
});
