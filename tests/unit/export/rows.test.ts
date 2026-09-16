import { describe, expect, it } from "vitest";
import {
  compareText,
  drawRows,
  feedbackRows,
  fromDivisionResults,
  itineraryRows,
  rawScoreRows,
  RESULT_STATUS_WORDS,
  resultRows,
  teamResultRows,
} from "@/domain/export/rows";
import { computeDivisionResults } from "@/domain/scoring";
import { divisionInput, MISSING_RECORD, receivedRecord, RESULTS, SCHEDULE } from "./fixtures";

describe("drawRows", () => {
  it("lists debates by round then room order with names resolved", () => {
    const rows = drawRows(SCHEDULE);
    expect(rows.map((row) => [row.division, row.round, row.room])).toEqual([
      ["Open", 1, "Room 1"],
      ["Novice", 1, "Room 2"],
      ["Open", 3, "Room 1"],
    ]);
    expect(rows[0]).toMatchObject({
      governmentCode: "O01",
      government: "=Compass",
      oppositionCode: "O02",
      opposition: "Lantern",
      judges: "Marisol Blake",
    });
  });

  it("filters by division", () => {
    expect(drawRows(SCHEDULE, "Novice")).toHaveLength(1);
  });
});

describe("itineraryRows", () => {
  it("gives each team one row per round with side and role labels", () => {
    const rows = itineraryRows(SCHEDULE, "Open");
    expect(
      rows.map((row) => [row.code, row.round, row.side, row.role1, row.role2, row.sidesDecided]),
    ).toEqual([
      ["O01", 1, "Government", "Prime Minister", "Government Minister", "in-advance"],
      ["O01", 3, "Opposition", "Leader of the Opposition", "Opposition Member", "in-room"],
      ["O02", 1, "Opposition", "Leader of the Opposition", "Opposition Member", "in-advance"],
      ["O02", 3, "Government", "Prime Minister", "Government Minister", "in-room"],
    ]);
    expect(rows[0]).toMatchObject({
      team: "=Compass",
      school: "Coral Bay Academy",
      opponentCode: "O02",
      opponent: "Lantern",
      room: "Room 1",
      debater1: "Amara Bennett",
      debater2: "Theo Campbell",
      judges: "Marisol Blake",
    });
  });

  it("uses the tournament's role labels", () => {
    const schedule = {
      ...SCHEDULE,
      settings: {
        ...SCHEDULE.settings,
        roles: { ...SCHEDULE.settings.roles, pm: "First Proposition" },
      },
    };
    expect(itineraryRows(schedule, "Open")[0].role1).toBe("First Proposition");
  });
});

describe("resultRows", () => {
  it("ranks first, leaves unscorable values blank and marks provisional", () => {
    const rows = resultRows(RESULTS);
    expect(rows.map((row) => [row.rank, row.name])).toEqual([
      [1, "Amara Bennett"],
      [2, "Theo Campbell"],
      [null, "Leila Foster"],
    ]);
    const leila = rows[2];
    expect(leila.total).toBeNull();
    expect(leila.roundAverages).toEqual([82, 80, null]);
    expect(leila.status).toBe("can't be scored yet");
    expect(leila.provisional).toBe("yes");
    expect(resultRows(RESULTS, false)[0].provisional).toBe("no");
  });

  it("projects team results the same way", () => {
    const rows = teamResultRows(RESULTS);
    expect(rows.map((row) => [row.rank, row.code, row.total, row.status])).toEqual([
      [1, "O01", 489, "ready"],
      [null, "O02", null, "can't be scored yet"],
    ]);
  });

  it("only ever writes the plain status words", () => {
    for (const words of Object.values(RESULT_STATUS_WORDS)) {
      expect(words).not.toMatch(/unresolved|incomplete|lopped|excluded/);
    }
  });
});

describe("fromDivisionResults", () => {
  const results = computeDivisionResults(divisionInput());
  const like = fromDivisionResults(results, "Open");
  const debater = (id: string) => like.debaters.find((entry) => entry.id === id)!;
  const team = (id: string) => like.teams.find((entry) => entry.id === id)!;

  it("fills team names and schools from the result's own team list", () => {
    expect(like.divisionCode).toBe("Open");
    expect(debater("spk-o01-1")).toMatchObject({
      name: "Amara Bennett",
      teamId: "team-o01",
      teamName: "=Compass",
      school: "Coral Bay Academy",
    });
  });

  it("takes round averages, total, average and spread from the scoring result", () => {
    const amara = debater("spk-o01-1");
    expect(amara.roundAverages).toEqual([84, 83]);
    expect(amara.total).toBe(167);
    expect(amara.average).toBeCloseTo(83.5, 10);
    expect(amara.spread).toBeCloseTo(Math.sqrt(1.1), 10);
    expect(amara.rank).toBe(1);
    expect(amara.status).toBe("ready");
  });

  it("keeps a debater who can't be scored yet unranked with a blank round", () => {
    const marcus = debater("spk-o02-2");
    expect(marcus.roundAverages).toEqual([74, null]);
    expect(marcus.total).toBeNull();
    expect(marcus.rank).toBeNull();
    expect(marcus.status).toBe("unresolved");
  });

  it("carries every team status through to plain words in the rows", () => {
    expect(team("team-o01")).toMatchObject({ code: "O01", total: 324, rank: 1, status: "ready" });
    expect(team("team-o02").status).toBe("unresolved");
    expect(team("team-o03").status).toBe("incomplete");
    expect(teamResultRows(like).map((row) => [row.code, row.status])).toEqual([
      ["O01", "ready"],
      ["O02", "can't be scored yet"],
      ["O03", "fewer than two debaters"],
    ]);
    expect(resultRows(like).map((row) => row.status)).not.toContain("unresolved");
  });
});

describe("rawScoreRows", () => {
  it("lists every debater in speaking order with all marks", () => {
    const rows = rawScoreRows([receivedRecord()]);
    expect(rows.map((row) => [row.debater, row.role, row.overall])).toEqual([
      ["Amara Bennett", "Prime Minister", 84],
      ["Leila Foster", "Leader of the Opposition", 82],
      ["Theo Campbell", "Government Minister", 78],
      ["Marcus Grant", "Opposition Member", 74],
    ]);
    expect(rows[0]).toMatchObject({
      division: "Open",
      round: 1,
      room: "Room 1",
      judge: "Marisol Blake",
      team: "=Compass",
      argumentation: 27,
      rebuttal: 26,
      presentation: 28,
      poi: 3,
      www: "Clear.",
      ebi: "Slower.",
      source: "judge",
      receivedAt: "2026-09-16T10:04:00.000Z",
    });
  });

  it("leaves a missing sheet blank", () => {
    const rows = rawScoreRows([MISSING_RECORD]);
    expect(rows).toHaveLength(4);
    expect(rows[0].overall).toBeNull();
    expect(rows[0].argumentation).toBeNull();
    expect(rows[0].www).toBe("");
    expect(rows[0].source).toBe("missing");
  });

  it("reflects a side flip and a role swap recorded on the sheet", () => {
    const record = receivedRecord();
    record.sheet!.payload.sideFlipped = true;
    record.sheet!.payload.roleSwaps = { "team-o01": true };
    const rows = rawScoreRows([record]);
    // Drawn Opposition now speaks as Government; Compass's teammates swapped.
    expect(rows.map((row) => [row.debater, row.role])).toEqual([
      ["Leila Foster", "Prime Minister"],
      ["Theo Campbell", "Leader of the Opposition"],
      ["Marcus Grant", "Government Minister"],
      ["Amara Bennett", "Opposition Member"],
    ]);
  });

  it("filters by division", () => {
    expect(rawScoreRows([receivedRecord()], "Novice")).toEqual([]);
  });
});

describe("feedbackRows", () => {
  it("gives one row per debater per judge, grouped by school and team", () => {
    const rows = feedbackRows([receivedRecord(), MISSING_RECORD]);
    expect(rows.map((row) => [row.school, row.debater, row.round, row.judge])).toEqual([
      ["Coral Bay Academy", "Amara Bennett", 1, "Marisol Blake"],
      ["Coral Bay Academy", "Theo Campbell", 1, "Marisol Blake"],
      ["Harbourview College", "Leila Foster", 1, "Marisol Blake"],
      ["Harbourview College", "Marcus Grant", 1, "Marisol Blake"],
    ]);
    expect(rows[0]).toMatchObject({
      team: "=Compass",
      role: "Prime Minister",
      opponent: "Lantern",
      room: "Room 1",
      overall: 84,
      www: "Clear.",
      ebi: "Slower.",
    });
  });
});

describe("compareText", () => {
  it("orders numbers inside codes numerically", () => {
    expect(["O10", "O2", "O1"].sort(compareText)).toEqual(["O1", "O2", "O10"]);
  });

  it("ignores case and accents so hosts agree on the order", () => {
    expect(["renée", "Renard", "Rena", "Renee"].sort(compareText)).toEqual([
      "Rena",
      "Renard",
      "renée",
      "Renee",
    ]);
    expect(compareText("Renée", "renee")).toBe(0);
  });
});
