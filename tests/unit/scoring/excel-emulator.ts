/**
 * A tiny, test-only emulator of the Excel functions the director's workbook
 * uses: AVERAGE, STDEV.S, AVERAGEIFS with text criteria, SUM and RANK.EQ.
 *
 * It is deliberately independent of the scoring engine: the engine is the
 * code under test and this file is the oracle. It is written to match Excel's
 * documented behaviour, not the engine's.
 *
 * - A blank cell is `null`. Functions ignore blanks the way Excel does.
 * - `#DIV/0!` is the string sentinel `DIV0`. Errors propagate through
 *   arithmetic and through any function that reads an error cell.
 * - Criteria text is built the way Excel builds `"<" & A1`: the number is
 *   written with at most 15 significant digits and parsed back.
 */

export const DIV0 = "#DIV/0!" as const;
export type ExcelError = typeof DIV0;
export type Cell = number | ExcelError | null;

const isNumber = (cell: Cell): cell is number => typeof cell === "number";
const isError = (cell: unknown): cell is ExcelError => cell === DIV0;

function numbers(cells: Cell[]): number[] | ExcelError {
  if (cells.some(isError)) return DIV0;
  return cells.filter(isNumber);
}

/** AVERAGE(range, ...): ignores blanks; #DIV/0! when no numbers. */
export function AVERAGE(...ranges: Cell[][]): number | ExcelError {
  const values = numbers(ranges.flat());
  if (values === DIV0 || values.length === 0) return DIV0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** STDEV.S(range, ...): sample standard deviation; #DIV/0! with fewer than two numbers. */
export function STDEV_S(...ranges: Cell[][]): number | ExcelError {
  const values = numbers(ranges.flat());
  if (values === DIV0 || values.length < 2) return DIV0;
  const mean = AVERAGE(values);
  if (mean === DIV0) return DIV0;
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

/** SUM(cells): blanks ignored, errors propagate. */
export function SUM(...ranges: Cell[][]): number | ExcelError {
  const values = numbers(ranges.flat());
  if (values === DIV0) return DIV0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}

/** `a + b` with error propagation. A blank counts as 0, as in Excel arithmetic. */
export function PLUS(a: Cell, b: Cell): number | ExcelError {
  if (isError(a) || isError(b)) return DIV0;
  return (a ?? 0) + (b ?? 0);
}

/** `a * b` with error propagation. */
export function TIMES(a: Cell, b: Cell): number | ExcelError {
  if (isError(a) || isError(b)) return DIV0;
  return (a ?? 0) * (b ?? 0);
}

/** `a - b` with error propagation. */
export function MINUS(a: Cell, b: Cell): number | ExcelError {
  if (isError(a) || isError(b)) return DIV0;
  return (a ?? 0) - (b ?? 0);
}

/**
 * A number written as text the way Excel's General format writes it into a
 * concatenation: at most 15 significant digits, no trailing zeros.
 */
export function numberToText(value: number): string {
  return String(Number(value.toPrecision(15)));
}

/** `op & cell`, e.g. `"<" & AY5`. An error cell makes the criterion an error. */
export function criterion(op: "<" | ">" | "<=" | ">=", cell: Cell): string | ExcelError {
  if (isError(cell)) return DIV0;
  return `${op}${numberToText(cell ?? 0)}`;
}

function parseCriterion(text: string): { op: string; bound: number } {
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(text);
  const op = match?.[1] ?? "=";
  const bound = Number(match?.[2] ?? "");
  return { op, bound };
}

function matches(cell: Cell, text: string): boolean {
  // Numeric comparison criteria never match a blank or a text cell.
  if (!isNumber(cell)) return false;
  const { op, bound } = parseCriterion(text);
  switch (op) {
    case "<":
      return cell < bound;
    case ">":
      return cell > bound;
    case "<=":
      return cell <= bound;
    case ">=":
      return cell >= bound;
    case "<>":
      return cell !== bound;
    default:
      return cell === bound;
  }
}

/**
 * AVERAGEIFS(average_range, criteria_range1, criteria1, ...): the average of
 * the cells in `averageRange` whose row meets every criterion. Non-numeric
 * cells in `averageRange` are ignored. #DIV/0! when nothing qualifies or when
 * a criterion is itself an error.
 */
export function AVERAGEIFS(
  averageRange: Cell[],
  ...pairs: [Cell[], string | ExcelError][]
): number | ExcelError {
  if (pairs.some(([, text]) => isError(text))) return DIV0;
  const qualifying: number[] = [];
  averageRange.forEach((cell, index) => {
    if (!isNumber(cell)) return;
    const ok = pairs.every(([range, text]) => matches(range[index], text as string));
    if (ok) qualifying.push(cell);
  });
  if (qualifying.length === 0) return DIV0;
  let sum = 0;
  for (const value of qualifying) sum += value;
  return sum / qualifying.length;
}

/**
 * RANK.EQ(number, ref, 0): descending rank; equal values share the rank.
 * Non-numeric cells in `ref` are ignored, which is the documented behaviour
 * for text and blanks. How Excel treats an error cell inside `ref` is the one
 * thing this emulator cannot decide (see docs/SCORING.md); the tests only
 * compare ranks over sets where every cell is a number.
 *
 * Values are compared at 15 significant digits, the precision Excel writes
 * and shows, so two sums that differ only in the last binary digit (the same
 * fractions added in a different order) share a rank.
 */
export function RANK_EQ(value: Cell, ref: Cell[]): number | ExcelError {
  if (!isNumber(value)) return DIV0;
  const key = Number(value.toPrecision(15));
  return 1 + ref.filter((cell) => isNumber(cell) && Number(cell.toPrecision(15)) > key).length;
}

/** One debater's row of the Master Sheet: judge score cells per round. */
export interface MasterRow {
  debaterId: string;
  teamId: string;
  /** Score cells per round, blanks as `null`. Judge-code cells are not included. */
  rounds: Cell[][];
}

export interface MasterRowResult {
  debaterId: string;
  teamId: string;
  /** AW */ mean: number | ExcelError;
  /** AX */ sd: number | ExcelError;
  /** AY */ upper: number | ExcelError;
  /** AZ */ lower: number | ExcelError;
  /** P / AD / AR */ roundAverages: (number | ExcelError)[];
  /** Q / AE / AS */ roundTeamScores: (number | ExcelError)[];
  /** R / AF / AT */ roundRanks: (number | ExcelError)[];
  /** S / AG / AU */ roundTeamRanks: (number | ExcelError)[];
  /** BA */ total: number | ExcelError;
  /** BB */ teamTotal: number | ExcelError;
  /** BC */ rank: number | ExcelError;
  /** BD */ teamRank: number | ExcelError;
}

/** Sum a cell over every member of a team: `SUMIF($C:$C, C5, P:P)`. */
function teamSum(
  rows: MasterRow[],
  teamId: string,
  cellOf: (row: MasterRow) => Cell,
): number | ExcelError {
  let sum: number | ExcelError = 0;
  for (const row of rows) if (row.teamId === teamId) sum = PLUS(sum, cellOf(row));
  return sum;
}

/** RANK.EQ over one cell per team (the workbook lists each team twice). */
function rankTeams(rows: MasterRow[], totals: Map<string, Cell>): Map<string, number | ExcelError> {
  const perTeam = new Map<string, Cell>();
  for (const row of rows)
    if (!perTeam.has(row.teamId)) perTeam.set(row.teamId, totals.get(row.teamId) ?? null);
  const ref = [...perTeam.values()];
  return new Map([...perTeam.entries()].map(([teamId, cell]) => [teamId, RANK_EQ(cell, ref)]));
}

/**
 * Evaluate the Master Sheet formulas for every row. The formula for each
 * column is named in docs/SCORING.md; this function is that list in code.
 */
export function evaluateMasterSheet(rows: MasterRow[]): MasterRowResult[] {
  const roundCount = rows[0]?.rounds.length ?? 0;
  const partial = rows.map((row) => {
    const all = row.rounds.flat();
    const mean = AVERAGE(all);
    const sd = STDEV_S(all);
    const upper = PLUS(mean, TIMES(2, sd));
    const lower = MINUS(mean, TIMES(2, sd));
    const roundAverages = row.rounds.map((cells) =>
      AVERAGEIFS(cells, [cells, criterion("<", upper)], [cells, criterion(">", lower)]),
    );
    const total = roundAverages.reduce<number | ExcelError>((sum, cell) => PLUS(sum, cell), 0);
    return { row, mean, sd, upper, lower, roundAverages, total };
  });
  const byId = new Map(partial.map((p) => [p.row.debaterId, p]));
  const teamTotals = new Map<string, Cell>();
  const roundTeamScores = new Map<string, (number | ExcelError)[]>();
  for (const row of rows) {
    if (teamTotals.has(row.teamId)) continue;
    teamTotals.set(
      row.teamId,
      teamSum(rows, row.teamId, (r) => byId.get(r.debaterId)?.total ?? null),
    );
    roundTeamScores.set(
      row.teamId,
      Array.from({ length: roundCount }, (_, round) =>
        teamSum(rows, row.teamId, (r) => byId.get(r.debaterId)?.roundAverages[round] ?? null),
      ),
    );
  }
  const totals = partial.map((p) => p.total);
  const teamRanks = rankTeams(rows, teamTotals);
  const roundTeamRanks = Array.from({ length: roundCount }, (_, round) =>
    rankTeams(rows, new Map([...roundTeamScores].map(([id, cells]) => [id, cells[round]]))),
  );
  return partial.map((p) => ({
    debaterId: p.row.debaterId,
    teamId: p.row.teamId,
    mean: p.mean,
    sd: p.sd,
    upper: p.upper,
    lower: p.lower,
    roundAverages: p.roundAverages,
    roundTeamScores: roundTeamScores.get(p.row.teamId) ?? [],
    roundRanks: p.roundAverages.map((cell, round) =>
      RANK_EQ(
        cell,
        partial.map((q) => q.roundAverages[round]),
      ),
    ),
    roundTeamRanks: roundTeamRanks.map((ranks) => ranks.get(p.row.teamId) ?? DIV0),
    total: p.total,
    teamTotal: teamTotals.get(p.row.teamId) ?? DIV0,
    rank: RANK_EQ(p.total, totals),
    teamRank: teamRanks.get(p.row.teamId) ?? DIV0,
  }));
}
