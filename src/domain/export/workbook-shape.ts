/**
 * The shape of the director's Master Sheet, as data. Nothing here holds
 * real names or scores: it is the column map the XLSX export fills and
 * the equivalence test checks against.
 *
 * Columns (56, A to BD):
 *   A School, B Pair label, C Team, D spacer, E Debater;
 *   per round: five judge slots as (code, score) pairs, then the round's
 *   individual average, team score, individual rank and team rank;
 *   then a spacer, then AW Average, AX Std Deviation, AY +2 SD, AZ −2 SD,
 *   BA Individual total, BB Team total, BC Individual rank, BD Team rank.
 *
 * Debaters occupy rows 5 to 44, teammates on adjacent rows.
 */
import type { Team } from "@/domain/types";
import { compareText } from "@/domain/export/rows";

export const WORKBOOK_ROUNDS = 3;
export const WORKBOOK_JUDGE_SLOTS = 5;
export const WORKBOOK_FIRST_ROW = 5;
export const WORKBOOK_LAST_ROW = 44;
/** Debaters the sheet has room for. */
export const WORKBOOK_ROW_CAPACITY = WORKBOOK_LAST_ROW - WORKBOOK_FIRST_ROW + 1;

export type WorkbookColumnKind =
  | "text"
  | "spacer"
  | "judge-code"
  | "judge-score"
  | "round-average"
  | "round-team-score"
  | "round-individual-rank"
  | "round-team-rank"
  | "average"
  | "spread"
  | "upper-bound"
  | "lower-bound"
  | "individual-total"
  | "team-total"
  | "individual-rank"
  | "team-rank";

export interface WorkbookColumn {
  /** 1-based column index. */
  index: number;
  /** Excel letter, e.g. "A", "AW". */
  letter: string;
  key: string;
  label: string;
  kind: WorkbookColumnKind;
  round?: number;
  /** 1-based judge slot within the round. */
  slot?: number;
}

/** Excel column letters for a 1-based index: 1 -> A, 27 -> AA. */
export function columnLetter(index: number): string {
  let letters = "";
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildColumns(): WorkbookColumn[] {
  const columns: Omit<WorkbookColumn, "index" | "letter">[] = [
    { key: "school", label: "School", kind: "text" },
    { key: "pair", label: "Pair", kind: "text" },
    { key: "team", label: "Team", kind: "text" },
    { key: "spacer-1", label: "", kind: "spacer" },
    { key: "debater", label: "Debater", kind: "text" },
  ];
  for (let round = 1; round <= WORKBOOK_ROUNDS; round += 1) {
    for (let slot = 1; slot <= WORKBOOK_JUDGE_SLOTS; slot += 1) {
      columns.push({
        key: `r${round}-j${slot}-code`,
        label: `R${round} Judge ${slot}`,
        kind: "judge-code",
        round,
        slot,
      });
      columns.push({
        key: `r${round}-j${slot}-score`,
        label: `R${round} Score ${slot}`,
        kind: "judge-score",
        round,
        slot,
      });
    }
    columns.push(
      { key: `r${round}-average`, label: `R${round} Average`, kind: "round-average", round },
      {
        key: `r${round}-team-score`,
        label: `R${round} Team score`,
        kind: "round-team-score",
        round,
      },
      {
        key: `r${round}-individual-rank`,
        label: `R${round} Individual rank`,
        kind: "round-individual-rank",
        round,
      },
      { key: `r${round}-team-rank`, label: `R${round} Team rank`, kind: "round-team-rank", round },
    );
  }
  columns.push(
    { key: "spacer-2", label: "", kind: "spacer" },
    { key: "average", label: "Average", kind: "average" },
    { key: "spread", label: "Std Deviation", kind: "spread" },
    { key: "upper-bound", label: "+2 SD", kind: "upper-bound" },
    { key: "lower-bound", label: "-2 SD", kind: "lower-bound" },
    { key: "individual-total", label: "Individual total", kind: "individual-total" },
    { key: "team-total", label: "Team total", kind: "team-total" },
    { key: "individual-rank", label: "Individual rank", kind: "individual-rank" },
    { key: "team-rank", label: "Team rank", kind: "team-rank" },
  );
  return columns.map((column, i) => ({ ...column, index: i + 1, letter: columnLetter(i + 1) }));
}

/** All 56 columns in sheet order. */
export const WORKBOOK_COLUMNS: WorkbookColumn[] = buildColumns();

/** Find a column by key; throws on a typo so the export never silently misplaces data. */
export function workbookColumn(key: string): WorkbookColumn {
  const column = WORKBOOK_COLUMNS.find((entry) => entry.key === key);
  if (!column) throw new Error(`Unknown workbook column "${key}"`);
  return column;
}

/** The fourteen columns for one round. */
export function roundColumns(round: number): WorkbookColumn[] {
  return WORKBOOK_COLUMNS.filter((column) => column.round === round);
}

/** The (code, score) pair for one judge slot in one round. */
export function judgeSlotColumns(
  round: number,
  slot: number,
): { code: WorkbookColumn; score: WorkbookColumn } {
  return {
    code: workbookColumn(`r${round}-j${slot}-code`),
    score: workbookColumn(`r${round}-j${slot}-score`),
  };
}

export interface DebaterRowLayout {
  /** Sheet row number. */
  row: number;
  team: Team;
  speakerId: string;
  debater: string;
  /** "Pair 1", "Pair 2", ... shared by both teammates. */
  pairLabel: string;
}

/**
 * Lay out debaters in sheet rows: one debater per row, teammates adjacent,
 * teams in code order. Returns more rows than the sheet holds when there
 * are more than 40 debaters; the caller decides how to handle that.
 */
export function layoutDebaterRows(teams: Team[]): DebaterRowLayout[] {
  const ordered = [...teams].sort((a, b) => compareText(a.code, b.code));
  const rows: DebaterRowLayout[] = [];
  let row = WORKBOOK_FIRST_ROW;
  ordered.forEach((team, pairIndex) => {
    const speakers = [...team.speakers].sort((a, b) => a.position - b.position);
    for (const speaker of speakers) {
      rows.push({
        row,
        team,
        speakerId: speaker.id,
        debater: speaker.name,
        pairLabel: `Pair ${pairIndex + 1}`,
      });
      row += 1;
    }
  });
  return rows;
}

/** True when every debater fits within rows 5 to 44. */
export function fitsWorkbook(teams: Team[]): boolean {
  const debaters = teams.reduce((sum, team) => sum + team.speakers.length, 0);
  return debaters <= WORKBOOK_ROW_CAPACITY;
}
