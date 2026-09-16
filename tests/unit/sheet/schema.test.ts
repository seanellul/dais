import { describe, expect, it } from "vitest";
import { parseSheetPayload, speakerScoreSchema } from "@/domain/sheet/schema";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { fullPayload, score, SPEAKER_IDS } from "./fixtures";

const rubric = DEFAULT_SETTINGS.rubric;
const options = { rubric, speakerIds: SPEAKER_IDS };

function errorsOf(input: unknown) {
  const result = parseSheetPayload(input, options);
  return result.ok ? [] : result.errors;
}

describe("speakerScoreSchema", () => {
  it("accepts marks within the rubric and trims comments", () => {
    const result = speakerScoreSchema(rubric).safeParse(score(82, { www: "  Good.  " }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.www).toBe("Good.");
  });

  it("rejects a category above its maximum with a plain message", () => {
    const result = speakerScoreSchema(rubric).safeParse(score(82, { argumentation: 34 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Argumentation must be a whole number between 0 and 33.",
      );
    }
  });

  it("rejects decimals when the rubric wants whole numbers", () => {
    const result = speakerScoreSchema(rubric).safeParse(score(82.5));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Overall score must be a whole number between 0 and 103.",
      );
    }
  });

  it("accepts decimals when the rubric allows them", () => {
    const loose = { ...rubric, integersOnly: false };
    expect(speakerScoreSchema(loose).safeParse(score(82.5)).success).toBe(true);
    const result = speakerScoreSchema(loose).safeParse(score(104));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Overall score must be a number between 0 and 103.",
      );
    }
  });

  it("rejects points of information above 4 and negatives", () => {
    expect(speakerScoreSchema(rubric).safeParse(score(80, { poi: 5 })).success).toBe(false);
    expect(speakerScoreSchema(rubric).safeParse(score(80, { rebuttal: -1 })).success).toBe(false);
  });

  it("caps comment length", () => {
    const long = "x".repeat(rubric.commentMaxLength + 1);
    const result = speakerScoreSchema(rubric).safeParse(score(80, { ebi: long }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Even better if must be 4000 characters or fewer.",
      );
    }
    expect(speakerScoreSchema(rubric).safeParse(score(80, { ebi: "x".repeat(4000) })).success).toBe(
      true,
    );
  });

  it("allows empty comments", () => {
    expect(speakerScoreSchema(rubric).safeParse(score(80, { www: "", ebi: "" })).success).toBe(
      true,
    );
  });
});

describe("parseSheetPayload", () => {
  it("accepts a complete sheet", () => {
    const result = parseSheetPayload(fullPayload(), options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.data.scores)).toHaveLength(4);
  });

  it("rejects a sheet missing a debater", () => {
    const payload = fullPayload();
    delete payload.scores["spk-o02-2"];
    const errors = errorsOf(payload);
    expect(errors).toEqual([
      { path: "scores.spk-o02-2", message: "One debater's scores are missing." },
    ]);
  });

  it("rejects a sheet with a debater who is not on it", () => {
    const payload = fullPayload();
    payload.scores["spk-o09-1"] = score(70);
    const errors = errorsOf(payload);
    expect(errors).toEqual([
      {
        path: "scores.spk-o09-1",
        message: "This sheet lists a debater who is not in this debate.",
      },
    ]);
  });

  it("reports the path of a bad mark inside the sheet", () => {
    const payload = fullPayload();
    payload.scores["spk-o01-1"].presentation = 40;
    const errors = errorsOf(payload);
    expect(errors).toEqual([
      {
        path: "scores.spk-o01-1.presentation",
        message: "Presentation must be a whole number between 0 and 33.",
      },
    ]);
  });

  it("requires sideFlipped and roleSwaps with plain messages", () => {
    const { scores } = fullPayload();
    const errors = errorsOf({ scores });
    expect(errors.map((error) => error.path).sort()).toEqual(["roleSwaps", "sideFlipped"]);
    expect(errors.find((error) => error.path === "sideFlipped")?.message).toBe(
      "Say whether the sides were swapped in the room.",
    );
  });

  it("rejects role swaps that are not booleans", () => {
    const payload = { ...fullPayload(), roleSwaps: { "team-o01": "yes" } };
    expect(errorsOf(payload)[0].path).toBe("roleSwaps.team-o01");
  });

  it("rejects a role swap for a team outside the debate when the teams are known", () => {
    const withTeams = { ...options, teamIds: ["team-o01", "team-o02"] };
    const stray = parseSheetPayload(
      { ...fullPayload(), roleSwaps: { "team-zzz": true } },
      withTeams,
    );
    expect(stray.ok).toBe(false);
    if (!stray.ok) {
      expect(stray.errors).toEqual([
        {
          path: "roleSwaps.team-zzz",
          message: "Role swaps must be for the two teams in this debate.",
        },
      ]);
    }
    const own = parseSheetPayload({ ...fullPayload(), roleSwaps: { "team-o01": true } }, withTeams);
    expect(own.ok).toBe(true);
  });

  it("accepts any team id in role swaps when the teams are not given", () => {
    expect(
      parseSheetPayload({ ...fullPayload(), roleSwaps: { "team-zzz": true } }, options).ok,
    ).toBe(true);
  });

  it("never puts an id in a message", () => {
    const payload = fullPayload();
    delete payload.scores["spk-o02-2"];
    payload.scores["spk-o09-1"] = score(70);
    for (const error of errorsOf(payload)) expect(error.message).not.toMatch(/spk-/);
  });

  it("never throws on nonsense", () => {
    expect(parseSheetPayload(null, options).ok).toBe(false);
    expect(parseSheetPayload(42, options).ok).toBe(false);
    expect(errorsOf({})[0].message).toBe("Scores are missing.");
  });
});
