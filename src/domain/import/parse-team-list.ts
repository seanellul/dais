/**
 * Parse a pasted team list in the director's spreadsheet shape: one debater
 * per line with school, debater and team columns (and an optional division
 * column). Rows are grouped into teams of two debaters and given codes.
 *
 * The parser never throws. Every problem becomes an issue with the line
 * number it came from, so the organiser can fix the paste and try again.
 */
import type { SpeakerPosition } from "@/domain/types";

export type Delimiter = "\t" | "," | ";";

/** A division the paste may name, by code or by name. */
export interface DivisionOption {
  code: string;
  name?: string;
}

export interface ParseTeamListOptions {
  /** Division for rows that have no Division column. */
  divisionCode?: string;
  /**
   * The tournament's divisions. When given, every division value must match
   * one by code or name (case does not matter) and is written back as the
   * code, so "open" and "Open (competitive)" both become "Open".
   */
  divisions?: DivisionOption[];
  /** Team codes already in use; new codes skip them. */
  existingCodes?: string[];
  /** Teams already in the tournament, to flag possible duplicates. */
  existingTeams?: { school: string; name: string }[];
}

export interface ParsedSpeaker {
  name: string;
  position: SpeakerPosition;
}

export interface ParsedTeam {
  code: string;
  name: string;
  school: string;
  divisionCode: string;
  /** At most two debaters; a third is reported as an error. */
  speakers: ParsedSpeaker[];
  /** 1-based line of the team's first debater in the pasted text. */
  row: number;
}

export interface TeamListIssue {
  /** 1-based line in the pasted text; 0 when the whole paste is at fault. */
  row: number;
  level: "error" | "warning";
  message: string;
}

export interface ParsedTeamList {
  teams: ParsedTeam[];
  issues: TeamListIssue[];
  /** True when no error-level issue was found. Warnings do not block. */
  ok: boolean;
  delimiter: Delimiter;
  hasHeader: boolean;
}

type ColumnRole = "school" | "debater" | "team" | "division";
type ColumnMap = Partial<Record<ColumnRole, number>>;

/** Header words the parser recognises, after lower-casing and removing non-letters. */
const HEADER_WORDS: Record<string, ColumnRole> = {
  school: "school",
  schoolname: "school",
  student: "debater",
  studentname: "debater",
  debater: "debater",
  debatername: "debater",
  name: "debater",
  team: "team",
  teamname: "team",
  division: "division",
  div: "division",
};

const DELIMITER_NAMES: Record<Delimiter, string> = {
  "\t": "tabs",
  ",": "commas",
  ";": "semicolons",
};

interface Line {
  row: number;
  text: string;
}

interface DebaterRow {
  row: number;
  school: string;
  name: string;
  team: string;
  divisionCode: string;
}

export function parseTeamList(text: string, options: ParseTeamListOptions = {}): ParsedTeamList {
  const issues: TeamListIssue[] = [];
  const lines = nonEmptyLines(text);
  const delimiter = detectDelimiter(lines.map((line) => line.text));

  if (lines.length === 0) {
    issues.push({
      row: 0,
      level: "error",
      message: "Nothing to import. Paste one debater per line.",
    });
    return { teams: [], issues, ok: false, delimiter, hasHeader: false };
  }

  const firstCells = splitRow(lines[0].text, delimiter);
  const headerColumns = detectHeader(firstCells);
  const hasHeader = headerColumns !== null;
  const columns = headerColumns ?? positionalColumns(firstCells.length);
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows: DebaterRow[] = [];
  for (const line of dataLines) {
    const row = readRow(line, splitRow(line.text, delimiter), columns, delimiter, options, issues);
    if (row) rows.push(row);
  }

  const teams = groupIntoTeams(rows, options, issues);
  issues.sort((a, b) => a.row - b.row);
  return {
    teams,
    issues,
    ok: !issues.some((issue) => issue.level === "error"),
    delimiter,
    hasHeader,
  };
}

function nonEmptyLines(text: string): Line[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((raw, index) => ({ row: index + 1, text: raw }))
    .filter((line) => line.text.trim().length > 0);
}

/** The delimiter that appears most often across the lines; tabs win ties. */
export function detectDelimiter(lines: string[]): Delimiter {
  const candidates: Delimiter[] = ["\t", ",", ";"];
  let best: Delimiter = "\t";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = lines.reduce((sum, line) => sum + line.split(candidate).length - 1, 0);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Split one line into tidied cells. A cell may be wrapped in double quotes
 * (spreadsheets do this when a value contains the delimiter); inside such a
 * cell a doubled quote stands for one quote.
 */
export function splitRow(line: string, delimiter: Delimiter): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.trim().length === 0) {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map(tidy);
}

/** Trim and collapse runs of whitespace to one space. */
export function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normaliseHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * A header row names at least two of school, debater and team. Returns the
 * column index for each role, or null when the first row is data.
 */
function detectHeader(cells: string[]): ColumnMap | null {
  const found: ColumnMap = {};
  cells.forEach((cell, index) => {
    const role = HEADER_WORDS[normaliseHeader(cell)];
    if (role && found[role] === undefined) found[role] = index;
  });
  const coreRoles: ColumnRole[] = ["school", "debater", "team"];
  const matched = coreRoles.filter((role) => found[role] !== undefined);
  return matched.length >= 2 ? found : null;
}

/** Without a header the columns are school, debater, team, then division. */
function positionalColumns(width: number): ColumnMap {
  const columns: ColumnMap = { school: 0, debater: 1, team: 2 };
  if (width >= 4) columns.division = 3;
  return columns;
}

function cellAt(cells: string[], index: number | undefined): string {
  return index === undefined ? "" : (cells[index] ?? "");
}

/** Read one data line, reporting missing fields. Returns null when the row is unusable. */
function readRow(
  line: Line,
  cells: string[],
  columns: ColumnMap,
  delimiter: Delimiter,
  options: ParseTeamListOptions,
  issues: TeamListIssue[],
): DebaterRow | null {
  const error = (message: string) => issues.push({ row: line.row, level: "error", message });

  if (cells.length < 3) {
    error(
      `Row ${line.row}: expected school, debater and team separated by ${DELIMITER_NAMES[delimiter]}.`,
    );
    return null;
  }

  const school = cellAt(cells, columns.school);
  const name = cellAt(cells, columns.debater);
  const team = cellAt(cells, columns.team);
  const divisionValue = cellAt(cells, columns.division) || tidy(options.divisionCode ?? "");

  const missing = [
    ["school", school],
    ["debater", name],
    ["team", team],
  ].filter(([, value]) => value.length === 0);
  for (const [field] of missing) error(`Row ${line.row}: the ${field} is missing.`);
  if (missing.length > 0) return null;

  if (divisionValue.length === 0) {
    error(
      `Row ${line.row}: no division given. Choose a division for the paste or add a Division column.`,
    );
    return null;
  }

  const divisionCode = matchDivision(divisionValue, options.divisions);
  if (divisionCode === null) {
    const known = (options.divisions ?? []).map((division) => division.code).join(", ");
    error(`Row ${line.row}: division "${divisionValue}" is not one of ${known}.`);
    return null;
  }

  return { row: line.row, school, name, team, divisionCode };
}

/**
 * The canonical code for a pasted division value, matched against the
 * tournament's divisions by code or name without regard to case. With no
 * division list the value is taken as it is. Null when nothing matches.
 */
export function matchDivision(value: string, divisions?: DivisionOption[]): string | null {
  if (!divisions) return value;
  const wanted = tidy(value).toLowerCase();
  const match = divisions.find(
    (division) =>
      tidy(division.code).toLowerCase() === wanted ||
      (division.name !== undefined && tidy(division.name).toLowerCase() === wanted),
  );
  return match ? match.code : null;
}

function teamKey(divisionCode: string, school: string, team: string): string {
  return [divisionCode, school, team].map((part) => part.toLowerCase()).join("|");
}

interface TeamGroup {
  row: number;
  school: string;
  name: string;
  divisionCode: string;
  debaters: { row: number; name: string }[];
}

/** Group rows by division, school and team, keeping first-seen order. */
function groupIntoTeams(
  rows: DebaterRow[],
  options: ParseTeamListOptions,
  issues: TeamListIssue[],
): ParsedTeam[] {
  const groups = new Map<string, TeamGroup>();
  for (const row of rows) {
    const key = teamKey(row.divisionCode, row.school, row.team);
    const group = groups.get(key) ?? {
      row: row.row,
      school: row.school,
      name: row.team,
      divisionCode: row.divisionCode,
      debaters: [],
    };
    group.debaters.push({ row: row.row, name: row.name });
    groups.set(key, group);
  }

  const codes = new CodeIssuer(options.existingCodes ?? []);
  const existing = new Set(
    (options.existingTeams ?? []).map((team) => teamKey("", tidy(team.school), tidy(team.name))),
  );

  return [...groups.values()].map((group) => {
    const debaters = dropDuplicateDebaters(group, issues);
    checkTeamSize(group, debaters.length, issues);
    if (existing.has(teamKey("", group.school, group.name))) {
      issues.push({
        row: group.row,
        level: "warning",
        message: `Team ${group.name} (${group.school}) looks like a duplicate of an existing team.`,
      });
    }
    return {
      code: codes.next(group.divisionCode),
      name: group.name,
      school: group.school,
      divisionCode: group.divisionCode,
      speakers: debaters.slice(0, 2).map((debater, index) => ({
        name: debater.name,
        position: (index + 1) as SpeakerPosition,
      })),
      row: group.row,
    };
  });
}

function dropDuplicateDebaters(group: TeamGroup, issues: TeamListIssue[]) {
  const seen = new Set<string>();
  return group.debaters.filter((debater) => {
    const key = debater.name.toLowerCase();
    if (seen.has(key)) {
      issues.push({
        row: debater.row,
        level: "error",
        message: `Row ${debater.row}: ${debater.name} is listed twice for team ${group.name} (${group.school}).`,
      });
      return false;
    }
    seen.add(key);
    return true;
  });
}

function checkTeamSize(group: TeamGroup, count: number, issues: TeamListIssue[]) {
  const who = `team ${group.name} (${group.school})`;
  if (count === 1) {
    issues.push({
      row: group.row,
      level: "warning",
      message: `Only one debater listed for ${who}. Add a partner, or continue with one.`,
    });
  } else if (count >= 3) {
    issues.push({
      row: group.row,
      level: "error",
      message: `${count} debaters listed for ${who}. A team has two debaters.`,
    });
  }
}

/**
 * Issues team codes: the division's first letter plus a two-digit index,
 * skipping codes already taken.
 */
export class CodeIssuer {
  private readonly taken: Set<string>;
  private readonly nextIndex = new Map<string, number>();

  constructor(existingCodes: string[]) {
    this.taken = new Set(existingCodes.map((code) => code.toUpperCase()));
  }

  next(divisionCode: string): string {
    const prefix = codePrefix(divisionCode);
    let index = this.nextIndex.get(prefix) ?? 1;
    let code = formatCode(prefix, index);
    while (this.taken.has(code)) {
      index += 1;
      code = formatCode(prefix, index);
    }
    this.taken.add(code);
    this.nextIndex.set(prefix, index + 1);
    return code;
  }
}

/** "Open" -> "O", "Novice" -> "N"; "T" when the division has no letter. */
export function codePrefix(divisionCode: string): string {
  const letter = divisionCode.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(letter) ? letter : "T";
}

function formatCode(prefix: string, index: number): string {
  return prefix + String(index).padStart(2, "0");
}
