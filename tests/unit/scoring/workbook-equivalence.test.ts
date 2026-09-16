/**
 * Workbook equivalence: the engine under WORKBOOK_POLICY must produce the same
 * numbers as the director's spreadsheet formulas, modelled by the test-only
 * Excel emulator.
 *
 * 1. A fast-check property over synthetic divisions (4..40 debaters, 1..5
 *    judge slots per round with blanks, whole-number overalls 40..103 with
 *    5% rogue scores): per-round averages, totals, "#DIV/0!" versus "can't
 *    be scored yet", ranks over the resolved set and team totals all agree.
 * 2. The golden fixture: forty invented debaters whose expected values were
 *    produced once by the emulator, and which a director can paste into a
 *    real spreadsheet to check (docs/SCORING.md explains how).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  WORKBOOK_POLICY,
  computeDivisionResults,
  type DebaterInput,
  type DivisionInput,
  type ScoreSource,
  type TeamInput,
} from "@/domain/scoring";
import golden from "../../fixtures/workbook-golden.json";
import { DIV0, evaluateMasterSheet, type Cell, type MasterRow } from "./excel-emulator";

const ROUNDS = [1, 2, 3];

/** A judge slot: blank, a rogue 40 or 103, or a plausible whole number. */
const slot = fc.oneof(
  { arbitrary: fc.constant(null), weight: 3 },
  { arbitrary: fc.constantFrom(40, 103), weight: 5 },
  { arbitrary: fc.integer({ min: 65, max: 95 }), weight: 92 },
);
const roundSlots = fc.array(slot, { minLength: 1, maxLength: 5 });
const debaterRounds = fc.tuple(roundSlots, roundSlots, roundSlots);
/** Two debaters per team, 2..20 teams, so 4..40 debaters. */
const synthetic = fc
  .integer({ min: 2, max: 20 })
  .chain((teams) => fc.array(debaterRounds, { minLength: teams * 2, maxLength: teams * 2 }));

type Rows = (Cell[] | readonly Cell[])[][];

/** Turn a grid of judge slots into the engine's input and the emulator's rows. */
function buildDivision(grid: Rows): { input: DivisionInput; rows: MasterRow[] } {
  const debaters: DebaterInput[] = grid.map((_, index) => ({
    id: `d${index}`,
    name: `Debater ${index}`,
    teamId: `t${Math.floor(index / 2)}`,
    position: index % 2 === 0 ? 1 : 2,
  }));
  const teams: TeamInput[] = Array.from({ length: Math.ceil(grid.length / 2) }, (_, index) => ({
    id: `t${index}`,
    code: `O${index}`,
    name: `Team ${index}`,
    school: "Invented School",
    debaterIds: [`d${index * 2}`, `d${index * 2 + 1}`],
  }));
  const scores: ScoreSource[] = grid.flatMap((rounds, debaterIndex) =>
    rounds.flatMap((slots, roundIndex) =>
      slots.flatMap((value, slotIndex) =>
        typeof value === "number"
          ? [
              {
                assignmentId: `asg-r${roundIndex + 1}-d${debaterIndex}-s${slotIndex}`,
                judgeId: `judge-${slotIndex}`,
                judgeName: `Judge ${slotIndex}`,
                round: roundIndex + 1,
                debaterId: `d${debaterIndex}`,
                value,
                sheetVersion: 1,
                source: "judge" as const,
              },
            ]
          : [],
      ),
    ),
  );
  const rows: MasterRow[] = grid.map((rounds, index) => ({
    debaterId: `d${index}`,
    teamId: `t${Math.floor(index / 2)}`,
    rounds: rounds.map((slots) => [...slots]),
  }));
  const input: DivisionInput = {
    divisionId: "synthetic",
    rounds: ROUNDS,
    debaters,
    teams,
    expectedSheets: [],
    scores,
    overrides: [],
    policy: WORKBOOK_POLICY,
    topN: 2,
  };
  return { input, rows };
}

const same = (engine: number | null, excel: number | typeof DIV0): boolean =>
  engine === null ? excel === DIV0 : excel !== DIV0 && Math.abs(engine - excel) < 1e-9;

describe("workbook equivalence (property)", () => {
  it("matches the Excel emulator on averages, totals, #DIV/0!, ranks and team totals", () => {
    fc.assert(
      fc.property(synthetic, (grid) => {
        const { input, rows } = buildDivision(grid);
        const engine = computeDivisionResults(input);
        const excel = evaluateMasterSheet(rows);

        engine.debaters.forEach((debater, index) => {
          const cell = excel[index];
          debater.rounds.forEach((round, roundIndex) => {
            expect(same(round.average, cell.roundAverages[roundIndex])).toBe(true);
          });
          expect(same(debater.total, cell.total)).toBe(true);
          expect(debater.status === "unresolved").toBe(cell.total === DIV0);
          // The emulator ranks numeric cells only, which is the resolved set.
          expect(debater.rank).toBe(cell.rank === DIV0 ? null : cell.rank);
        });

        engine.teams.forEach((team) => {
          const cell = excel.find((row) => row.teamId === team.id);
          expect(cell).toBeDefined();
          expect(same(team.total, cell?.teamTotal ?? DIV0)).toBe(true);
          expect(team.rank).toBe(cell?.teamRank === DIV0 ? null : cell?.teamRank);
        });
      }),
      { numRuns: 500, seed: 20260916, endOnFailure: true },
    );
  });
});

describe("workbook equivalence (golden fixture)", () => {
  const grid: Rows = golden.rows.map((row) =>
    row.rounds.map((slots) => slots.map((s) => (s ? s.value : null))),
  );
  const judgeName = new Map(golden.judges.map((j) => [j.id, j.name]));
  const input: DivisionInput = {
    divisionId: "golden",
    rounds: golden.rounds,
    debaters: golden.debaters.map((d) => ({ ...d, position: d.position as 1 | 2 })),
    teams: golden.teams,
    expectedSheets: [],
    scores: golden.rows.flatMap((row, debaterIndex) =>
      row.rounds.flatMap((slots, roundIndex) =>
        slots.flatMap((s) =>
          s
            ? [
                {
                  assignmentId: `asg-r${golden.rounds[roundIndex]}-${golden.debaters[debaterIndex].teamId}-${s.judgeId}`,
                  judgeId: s.judgeId,
                  judgeName: judgeName.get(s.judgeId) ?? s.judgeId,
                  round: golden.rounds[roundIndex],
                  debaterId: row.debaterId,
                  value: s.value,
                  sheetVersion: 1,
                  source: "judge" as const,
                },
              ]
            : [],
        ),
      ),
    ),
    overrides: [],
    policy: WORKBOOK_POLICY,
    topN: 2,
  };
  const engine = computeDivisionResults(input);

  it("has forty debaters, three rounds and no #DIV/0! cells", () => {
    expect(golden.debaters).toHaveLength(40);
    expect(golden.rounds).toEqual([1, 2, 3]);
    expect(golden.policy).toEqual(WORKBOOK_POLICY);
    expect(JSON.stringify(golden.expected)).not.toContain(DIV0);
    expect(engine.completeness.finalizable).toBe(true);
  });

  it("reproduces every expected cell exactly", () => {
    engine.debaters.forEach((debater, index) => {
      const expected = golden.expected.debaters[index];
      expect(debater.id).toBe(expected.id);
      expect(debater.stats.scope === "pooled" && debater.stats.mean).toBe(expected.mean);
      expect(debater.stats.scope === "pooled" && debater.stats.sd).toBe(expected.sd);
      expect(debater.stats.scope === "pooled" && debater.stats.upper).toBe(expected.upper);
      expect(debater.stats.scope === "pooled" && debater.stats.lower).toBe(expected.lower);
      expect(debater.rounds.map((round) => round.average)).toEqual(expected.roundAverages);
      expect(debater.total).toBe(expected.total);
      expect(debater.rank).toBe(expected.rank);
      const setAside = debater.rounds.flatMap((round) =>
        round.sources
          .filter((s) => s.status === "lopped")
          .map((s) => ({ round: s.round, judgeId: s.judgeId, value: s.value })),
      );
      expect(setAside).toEqual(expected.setAside);
    });
    engine.teams.forEach((team, index) => {
      const expected = golden.expected.teams[index];
      expect(team.id).toBe(expected.id);
      expect(team.total).toBe(expected.total);
      expect(team.rank).toBe(expected.rank);
    });
  });

  it("agrees with the emulator when re-evaluated from the raw grid", () => {
    const excel = evaluateMasterSheet(
      grid.map((rounds, index) => ({
        debaterId: golden.rows[index].debaterId,
        teamId: golden.debaters[index].teamId,
        rounds: rounds.map((slots) => [...slots]),
      })),
    );
    excel.forEach((row, index) => {
      expect(row.total).toBe(golden.expected.debaters[index].total);
      expect(row.rank).toBe(golden.expected.debaters[index].rank);
    });
  });

  it("names at least three set-aside scores for the director to look at", () => {
    const count = golden.expected.debaters.reduce((sum, d) => sum + d.setAside.length, 0);
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
