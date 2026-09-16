import { describe, expect, it } from "vitest";
import {
  columnLetter,
  fitsWorkbook,
  judgeSlotColumns,
  layoutDebaterRows,
  roundColumns,
  WORKBOOK_COLUMNS,
  WORKBOOK_FIRST_ROW,
  WORKBOOK_ROW_CAPACITY,
  workbookColumn,
} from "@/domain/export/workbook-shape";
import { SCHEDULE } from "./fixtures";

describe("workbook columns", () => {
  it("has 56 columns from A to BD", () => {
    expect(WORKBOOK_COLUMNS).toHaveLength(56);
    expect(WORKBOOK_COLUMNS[0].letter).toBe("A");
    expect(WORKBOOK_COLUMNS[55].letter).toBe("BD");
    expect(WORKBOOK_COLUMNS.map((column) => column.index)).toEqual(
      Array.from({ length: 56 }, (_, i) => i + 1),
    );
  });

  it("places the director's fixed columns where the sheet has them", () => {
    expect(workbookColumn("school").letter).toBe("A");
    expect(workbookColumn("pair").letter).toBe("B");
    expect(workbookColumn("team").letter).toBe("C");
    expect(workbookColumn("debater").letter).toBe("E");
    expect(workbookColumn("average").letter).toBe("AW");
    expect(workbookColumn("spread").letter).toBe("AX");
    expect(workbookColumn("upper-bound").letter).toBe("AY");
    expect(workbookColumn("lower-bound").letter).toBe("AZ");
    expect(workbookColumn("individual-total").letter).toBe("BA");
    expect(workbookColumn("team-total").letter).toBe("BB");
    expect(workbookColumn("individual-rank").letter).toBe("BC");
    expect(workbookColumn("team-rank").letter).toBe("BD");
  });

  it("gives each round fourteen columns: five judge pairs and four summaries", () => {
    for (const round of [1, 2, 3]) {
      const columns = roundColumns(round);
      expect(columns).toHaveLength(14);
      expect(columns.filter((c) => c.kind === "judge-code")).toHaveLength(5);
      expect(columns.filter((c) => c.kind === "judge-score")).toHaveLength(5);
      expect(columns.slice(10).map((c) => c.kind)).toEqual([
        "round-average",
        "round-team-score",
        "round-individual-rank",
        "round-team-rank",
      ]);
    }
    expect(roundColumns(1)[0].letter).toBe("F");
    expect(roundColumns(3)[13].letter).toBe("AU");
  });

  it("pairs a judge slot's code and score columns", () => {
    const { code, score } = judgeSlotColumns(2, 1);
    expect(code.letter).toBe("T");
    expect(score.letter).toBe("U");
    expect(code.round).toBe(2);
    expect(score.slot).toBe(1);
  });

  it("throws on an unknown column key so a typo cannot misplace data", () => {
    expect(() => workbookColumn("nope")).toThrow('Unknown workbook column "nope"');
  });
});

describe("columnLetter", () => {
  it("converts indexes to Excel letters", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(52)).toBe("AZ");
    expect(columnLetter(53)).toBe("BA");
  });
});

describe("layoutDebaterRows", () => {
  it("puts teammates on adjacent rows from row 5, teams in code order", () => {
    const rows = layoutDebaterRows(SCHEDULE.teams);
    expect(rows.map((row) => [row.row, row.team.code, row.debater, row.pairLabel])).toEqual([
      [5, "N01", "Nadia Hall", "Pair 1"],
      [6, "N01", "Elias James", "Pair 1"],
      [7, "N02", "Sofia Khan", "Pair 2"],
      [8, "N02", "Jonah Lewis", "Pair 2"],
      [9, "O01", "Amara Bennett", "Pair 3"],
      [10, "O01", "Theo Campbell", "Pair 3"],
      [11, "O02", "Leila Foster", "Pair 4"],
      [12, "O02", "Marcus Grant", "Pair 4"],
    ]);
    expect(rows[0].row).toBe(WORKBOOK_FIRST_ROW);
  });

  it("knows the sheet holds forty debaters", () => {
    expect(WORKBOOK_ROW_CAPACITY).toBe(40);
    expect(fitsWorkbook(SCHEDULE.teams)).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...SCHEDULE.teams[0],
      code: `O${i + 1}`,
    }));
    expect(fitsWorkbook(many)).toBe(false);
  });
});
