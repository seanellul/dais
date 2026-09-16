/**
 * Header-and-rows specs for each CSV download. A route handler turns one
 * of these into a file with `csvText(spec.headers, spec.rows)`.
 *
 * Every spec that names a speaking role takes the tournament's role labels,
 * so a renamed role reads the same in every file.
 */
import { DEFAULT_ROLE_LABELS, type RoleLabels, type Schedule } from "@/domain/types";
import type { CsvValue } from "@/domain/export/csv";
import {
  drawRows,
  feedbackRows,
  itineraryRows,
  rawScoreRows,
  resultRows,
  teamResultRows,
  type DivisionResultsLike,
  type SheetRecord,
} from "@/domain/export/rows";

export interface CsvSpec {
  headers: string[];
  rows: CsvValue[][];
}

export function drawCsv(schedule: Schedule, divisionCode?: string): CsvSpec {
  return {
    headers: [
      "Division",
      "Round",
      "Room",
      "Government code",
      "Government",
      "Opposition code",
      "Opposition",
      "Judges",
      "Motion",
    ],
    rows: drawRows(schedule, divisionCode).map((row) => [
      row.division,
      row.round,
      row.room,
      row.governmentCode,
      row.government,
      row.oppositionCode,
      row.opposition,
      row.judges,
      row.motion,
    ]),
  };
}

export function itineraryCsv(schedule: Schedule, divisionCode?: string): CsvSpec {
  return {
    headers: [
      "Division",
      "Code",
      "Team",
      "School",
      "Round",
      "Opponent code",
      "Opponent",
      "Room",
      "Side",
      "Sides decided",
      "First debater",
      "Role",
      "Second debater",
      "Role",
      "Judges",
    ],
    rows: itineraryRows(schedule, divisionCode).map((row) => [
      row.division,
      row.code,
      row.team,
      row.school,
      row.round,
      row.opponentCode,
      row.opponent,
      row.room,
      row.side,
      row.sidesDecided === "in-room" ? "Coin toss in the room" : "In advance",
      row.debater1,
      row.role1,
      row.debater2,
      row.role2,
      row.judges,
    ]),
  };
}

/** Debater results. `roundCount` sets how many "R<n> average" columns appear. */
export function resultsCsv(
  results: DivisionResultsLike,
  roundCount: number,
  provisional = true,
): CsvSpec {
  const roundHeaders = Array.from({ length: roundCount }, (_, i) => `R${i + 1} average`);
  return {
    headers: [
      "ID",
      "Name",
      "Team",
      "School",
      ...roundHeaders,
      "Total",
      "Average",
      "Spread",
      "Rank",
      "Status",
      "Provisional",
    ],
    rows: resultRows(results, provisional).map((row) => [
      row.id,
      row.name,
      row.team,
      row.school,
      ...Array.from({ length: roundCount }, (_, i) => row.roundAverages[i] ?? null),
      row.total,
      row.average,
      row.spread,
      row.rank,
      row.status,
      row.provisional,
    ]),
  };
}

export function teamResultsCsv(results: DivisionResultsLike, provisional = true): CsvSpec {
  return {
    headers: ["Code", "Team", "School", "Total", "Rank", "Status", "Provisional"],
    rows: teamResultRows(results, provisional).map((row) => [
      row.code,
      row.team,
      row.school,
      row.total,
      row.rank,
      row.status,
      row.provisional,
    ]),
  };
}

export function rawScoresCsv(
  records: SheetRecord[],
  divisionCode?: string,
  roles: RoleLabels = DEFAULT_ROLE_LABELS,
): CsvSpec {
  return {
    headers: [
      "Division",
      "Round",
      "Room",
      "Judge",
      "Debater",
      "Team",
      "Role",
      "Argumentation",
      "Rebuttal",
      "Presentation",
      "POI",
      "Overall",
      "What went well",
      "Even better if",
      "Source",
      "Received at",
    ],
    rows: rawScoreRows(records, divisionCode, roles).map((row) => [
      row.division,
      row.round,
      row.room,
      row.judge,
      row.debater,
      row.team,
      row.role,
      row.argumentation,
      row.rebuttal,
      row.presentation,
      row.poi,
      row.overall,
      row.www,
      row.ebi,
      row.source,
      row.receivedAt,
    ]),
  };
}

export function feedbackCsv(
  records: SheetRecord[],
  divisionCode?: string,
  roles: RoleLabels = DEFAULT_ROLE_LABELS,
): CsvSpec {
  return {
    headers: [
      "Division",
      "School",
      "Team",
      "Debater",
      "Round",
      "Role",
      "Opponent",
      "Room",
      "Judge",
      "Overall",
      "What went well",
      "Even better if",
    ],
    rows: feedbackRows(records, divisionCode, roles).map((row) => [
      row.division,
      row.school,
      row.team,
      row.debater,
      row.round,
      row.role,
      row.opponent,
      row.room,
      row.judge,
      row.overall,
      row.www,
      row.ebi,
    ]),
  };
}
