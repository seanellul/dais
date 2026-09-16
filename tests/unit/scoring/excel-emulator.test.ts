/**
 * The emulator is the oracle for the workbook-equivalence tests, so it has a
 * few checks of its own against documented Excel behaviour.
 */

import { describe, expect, it } from "vitest";
import {
  AVERAGE,
  AVERAGEIFS,
  DIV0,
  RANK_EQ,
  STDEV_S,
  SUM,
  criterion,
  evaluateMasterSheet,
  numberToText,
} from "./excel-emulator";

describe("Excel emulator", () => {
  it("AVERAGE and STDEV.S ignore blanks and return #DIV/0! when undefined", () => {
    expect(AVERAGE([10, null, 20])).toBe(15);
    expect(AVERAGE([null, null])).toBe(DIV0);
    expect(STDEV_S([10, null, 20])).toBe(Math.sqrt(50));
    expect(STDEV_S([10])).toBe(DIV0);
    expect(SUM([1, null, 2])).toBe(3);
    expect(SUM([1, DIV0])).toBe(DIV0);
  });

  it("writes numbers into criteria text with at most 15 significant digits", () => {
    expect(numberToText(70)).toBe("70");
    expect(numberToText(0.1 + 0.2)).toBe("0.3");
    expect(numberToText(83.4000000000000056)).toBe("83.4");
    expect(criterion("<", 70.00000000000001)).toBe("<70");
    expect(criterion(">", DIV0)).toBe(DIV0);
  });

  it("AVERAGEIFS compares strictly, skips blanks and text, and errors when nothing qualifies", () => {
    const cells = [47, null, 47, null, 42, null, 70];
    expect(AVERAGEIFS(cells, [cells, "<70"], [cells, ">30"])).toBe((47 + 47 + 42) / 3);
    expect(AVERAGEIFS(cells, [cells, "<=70"], [cells, ">30"])).toBe((47 + 47 + 42 + 70) / 4);
    expect(AVERAGEIFS(cells, [cells, "<40"], [cells, ">30"])).toBe(DIV0);
    expect(AVERAGEIFS(cells, [cells, criterion("<", DIV0)], [cells, ">30"])).toBe(DIV0);
    // A bound that differs from 70 only beyond 15 significant digits reads as 70.
    expect(AVERAGEIFS(cells, [cells, criterion("<", 70.00000000000001)], [cells, ">0"])).toBe(
      (47 + 47 + 42) / 3,
    );
  });

  it("RANK.EQ ranks descending over numeric cells only", () => {
    expect(RANK_EQ(80, [100, 80, 80, 50])).toBe(2);
    expect(RANK_EQ(50, [100, 80, 80, 50])).toBe(4);
    expect(RANK_EQ(50, [100, null, 50])).toBe(2);
    expect(RANK_EQ(DIV0, [100, 50])).toBe(DIV0);
  });

  it("evaluates a Master Sheet row the way the workbook formulas do", () => {
    const rows = [
      {
        debaterId: "a",
        teamId: "t1",
        rounds: [
          [47, null, null, null, null],
          [47, null, null, null, null],
          [47, 47, 42, 70, null],
        ],
      },
      {
        debaterId: "b",
        teamId: "t1",
        rounds: [
          [50, null, null, null, null],
          [60, null, null, null, null],
          [70, null, null, null, null],
        ],
      },
      {
        debaterId: "c",
        teamId: "t2",
        rounds: [
          [7, null, null, null, null],
          [7, null, null, null, null],
          [7, null, null, null, null],
        ],
      },
      {
        debaterId: "d",
        teamId: "t2",
        rounds: [
          [7, null, null, null, null],
          [8, null, null, null, null],
          [9, null, null, null, null],
        ],
      },
    ];
    const [a, b, c, d] = evaluateMasterSheet(rows);
    expect(a).toMatchObject({
      mean: 50,
      sd: 10,
      upper: 70,
      lower: 30,
      roundAverages: [47, 47, (47 + 47 + 42) / 3],
      total: 47 + 47 + (47 + 47 + 42) / 3,
    });
    expect(b.total).toBe(180);
    expect(a.teamTotal).toBe(b.teamTotal);
    expect(a.teamTotal).toBe((a.total as number) + 180);
    expect(c).toMatchObject({
      sd: 0,
      roundAverages: [DIV0, DIV0, DIV0],
      total: DIV0,
      teamTotal: DIV0,
      rank: DIV0,
      teamRank: DIV0,
    });
    expect(d.total).toBe(24);
    expect([a.rank, b.rank, d.rank]).toEqual([2, 1, 3]);
    expect([a.teamRank, d.teamRank]).toEqual([1, DIV0]);
    expect(a.roundRanks).toEqual([2, 2, 2]);
    expect(a.roundTeamScores).toEqual([97, 107, (47 + 47 + 42) / 3 + 70]);
  });
});
