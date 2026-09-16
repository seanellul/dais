import { describe, expect, it } from "vitest";
import { csvText } from "@/domain/export/csv";
import {
  drawCsv,
  feedbackCsv,
  itineraryCsv,
  rawScoresCsv,
  resultsCsv,
  teamResultsCsv,
} from "@/domain/export/csv-specs";
import { fromDivisionResults } from "@/domain/export/rows";
import { computeDivisionResults } from "@/domain/scoring";
import { DEFAULT_ROLE_LABELS } from "@/domain/types";
import { divisionInput, MISSING_RECORD, receivedRecord, RESULTS, SCHEDULE } from "./fixtures";

describe("csv specs", () => {
  it("keeps every row the same width as its header", () => {
    const specs = [
      drawCsv(SCHEDULE),
      itineraryCsv(SCHEDULE, "Open"),
      resultsCsv(RESULTS, 3),
      teamResultsCsv(RESULTS),
      rawScoresCsv([receivedRecord(), MISSING_RECORD]),
      feedbackCsv([receivedRecord()]),
    ];
    for (const spec of specs) {
      expect(spec.rows.length).toBeGreaterThan(0);
      for (const row of spec.rows) expect(row).toHaveLength(spec.headers.length);
    }
  });

  it("expands one average column per round", () => {
    expect(resultsCsv(RESULTS, 3).headers.filter((h) => h.endsWith("average"))).toEqual([
      "R1 average",
      "R2 average",
      "R3 average",
    ]);
    expect(resultsCsv(RESULTS, 2).rows[0]).toHaveLength(resultsCsv(RESULTS, 2).headers.length);
  });

  it("neutralises a team name that looks like a formula when rendered", () => {
    const text = csvText(drawCsv(SCHEDULE).headers, drawCsv(SCHEDULE).rows);
    expect(text).toContain("'=Compass");
  });

  it("spells out how sides are decided", () => {
    const rows = itineraryCsv(SCHEDULE, "Open").rows;
    expect(rows[0]).toContain("In advance");
    expect(rows[1]).toContain("Coin toss in the room");
  });

  it("never writes a technical status word from the scoring engine", () => {
    const like = fromDivisionResults(computeDivisionResults(divisionInput()), "Open");
    const cells = [...resultsCsv(like, 2).rows, ...teamResultsCsv(like).rows].flat();
    expect(cells).not.toContain("unresolved");
    expect(cells).not.toContain("incomplete");
    expect(cells).toContain("can't be scored yet");
    expect(cells).toContain("fewer than two debaters");
  });

  it("uses the tournament's role labels in raw scores and feedback", () => {
    const roles = { ...DEFAULT_ROLE_LABELS, pm: "First Proposition" };
    const raw = rawScoresCsv([receivedRecord()], undefined, roles);
    const feedback = feedbackCsv([receivedRecord()], undefined, roles);
    expect(raw.rows[0][raw.headers.indexOf("Role")]).toBe("First Proposition");
    expect(feedback.rows[0][feedback.headers.indexOf("Role")]).toBe("First Proposition");
    expect(rawScoresCsv([receivedRecord()]).rows[0]).toContain("Prime Minister");
  });
});
