/**
 * Pure projections from the schedule, sheets and results into flat rows.
 * Every export (CSV, workbook, print) starts from one of these so the
 * numbers and names agree everywhere.
 *
 * Results come in through a small structural interface rather than the
 * scoring module's own type, so tests can build them by hand. Anything
 * with these fields fits, and `fromDivisionResults` builds one from the
 * scoring engine's output.
 *
 * Statuses arrive as the scoring engine's technical words and leave as the
 * plain words the organiser reads on screen: "can't be scored yet", never
 * "unresolved".
 */
import {
  DEFAULT_ROLE_LABELS,
  type Assignment,
  type RoleLabels,
  type Schedule,
  type SheetPayload,
  type Side,
  type Team,
} from "@/domain/types";
import type { DebaterStatus, DivisionResults, TeamStatus } from "@/domain/scoring";
import { actualSide, roleFor, roleLabel, SIDE_LABELS } from "@/domain/rubric/roles";

// ---------------------------------------------------------------------------
// Text order

/**
 * Text order that is the same on every host: English rules, numbers in
 * numeric order ("O2" before "O10"), accents and case ignored. The runtime's
 * default locale is never used, so a server and a browser sort alike.
 */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

// ---------------------------------------------------------------------------
// Draw

export interface DrawRow {
  division: string;
  round: number;
  room: string;
  governmentCode: string;
  government: string;
  oppositionCode: string;
  opposition: string;
  /** Judge names joined with " / ", in seat order. */
  judges: string;
  motion: string;
}

/** One row per debate, sorted by round then room order. */
export function drawRows(schedule: Schedule, divisionCode?: string): DrawRow[] {
  const teams = byId(schedule.teams);
  const rooms = byId(schedule.rooms);
  const judges = byId(schedule.judges);
  return schedule.debates
    .filter((debate) => !divisionCode || debate.divisionCode === divisionCode)
    .sort((a, b) => a.round - b.round || roomOrder(rooms, a.roomId) - roomOrder(rooms, b.roomId))
    .map((debate) => {
      const government = teams.get(debate.governmentTeamId);
      const opposition = teams.get(debate.oppositionTeamId);
      return {
        division: debate.divisionCode,
        round: debate.round,
        room: rooms.get(debate.roomId)?.name ?? debate.roomId,
        governmentCode: government?.code ?? "",
        government: government?.name ?? "",
        oppositionCode: opposition?.code ?? "",
        opposition: opposition?.name ?? "",
        judges: debate.judgeIds.map((id) => judges.get(id)?.name ?? id).join(" / "),
        motion: debate.motion,
      };
    });
}

// ---------------------------------------------------------------------------
// Team itineraries

export interface ItineraryRow {
  division: string;
  code: string;
  team: string;
  school: string;
  round: number;
  opponentCode: string;
  opponent: string;
  room: string;
  /** "Government" or "Opposition", as drawn. */
  side: string;
  /** "in-room" means a coin toss decides the sides on the day. */
  sidesDecided: "in-advance" | "in-room";
  debater1: string;
  role1: string;
  debater2: string;
  role2: string;
  judges: string;
}

/** One row per team per round, sorted by team code then round. */
export function itineraryRows(schedule: Schedule, divisionCode?: string): ItineraryRow[] {
  const teams = byId(schedule.teams);
  const rooms = byId(schedule.rooms);
  const judges = byId(schedule.judges);
  const roles = schedule.settings.roles;
  const rows: ItineraryRow[] = [];

  const selected = schedule.teams
    .filter((team) => !divisionCode || team.divisionCode === divisionCode)
    .sort((a, b) => compareText(a.code, b.code));

  for (const team of selected) {
    const debates = schedule.debates
      .filter(
        (debate) => debate.governmentTeamId === team.id || debate.oppositionTeamId === team.id,
      )
      .sort((a, b) => a.round - b.round);
    for (const debate of debates) {
      const side: Side = debate.governmentTeamId === team.id ? "government" : "opposition";
      const opponent = teams.get(
        side === "government" ? debate.oppositionTeamId : debate.governmentTeamId,
      );
      const roundSetting = schedule.settings.rounds.find((round) => round.number === debate.round);
      rows.push({
        division: team.divisionCode,
        code: team.code,
        team: team.name,
        school: team.school,
        round: debate.round,
        opponentCode: opponent?.code ?? "",
        opponent: opponent?.name ?? "",
        room: rooms.get(debate.roomId)?.name ?? debate.roomId,
        side: SIDE_LABELS[side],
        sidesDecided: roundSetting?.sidesDecided ?? "in-advance",
        debater1: speakerName(team, 1),
        role1: roleLabel(roleFor(side, 1), roles),
        debater2: speakerName(team, 2),
        role2: roleLabel(roleFor(side, 2), roles),
        judges: debate.judgeIds.map((id) => judges.get(id)?.name ?? id).join(" / "),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Results

/** A result status as the scoring engine says it. */
export type ResultStatus = DebaterStatus | TeamStatus;

/** The plain words for each status, as the organiser reads them. */
export const RESULT_STATUS_WORDS: Record<ResultStatus, string> = {
  ready: "ready",
  unresolved: "can't be scored yet",
  incomplete: "fewer than two debaters",
};

/** The plain words for a status, for any user-facing export. */
export function resultStatusWords(status: ResultStatus): string {
  return RESULT_STATUS_WORDS[status];
}

/** The fields this module needs from one debater's result. */
export interface ResultDebaterLike {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  school?: string;
  /** Per-round averages of the kept scores, in round order; null when not yet scorable. */
  roundAverages: (number | null)[];
  total: number | null;
  /** The average of all the debater's scores across rounds (the workbook's AVERAGE). */
  average: number | null;
  /** The spread of those scores (the workbook's STDEV.S). */
  spread: number | null;
  rank: number | null;
  /** The scoring engine's status; rows translate it to plain words. */
  status: DebaterStatus;
}

/** The fields this module needs from one team's result. */
export interface ResultTeamLike {
  id: string;
  code?: string;
  name: string;
  school?: string;
  total: number | null;
  rank: number | null;
  /** The scoring engine's status; rows translate it to plain words. */
  status: TeamStatus;
}

export interface DivisionResultsLike {
  divisionCode: string;
  debaters: ResultDebaterLike[];
  teams: ResultTeamLike[];
}

/**
 * The export shape of one division's results. Team names and schools come
 * from the result's own team list. The average and spread are the
 * workbook's pooled columns, so they are null under a per-round policy.
 */
export function fromDivisionResults(
  results: DivisionResults,
  divisionCode: string,
): DivisionResultsLike {
  const teams = byId(results.teams);
  return {
    divisionCode,
    debaters: results.debaters.map((debater) => {
      const team = teams.get(debater.teamId);
      const pooled = debater.stats.scope === "pooled" ? debater.stats : null;
      return {
        id: debater.id,
        name: debater.name,
        teamId: debater.teamId,
        teamName: team?.name ?? "",
        school: team?.school ?? "",
        roundAverages: debater.rounds.map((round) => round.average),
        total: debater.total,
        average: pooled?.mean ?? null,
        spread: pooled?.sd ?? null,
        rank: debater.rank,
        status: debater.status,
      };
    }),
    teams: results.teams.map((team) => ({
      id: team.id,
      code: team.code,
      name: team.name,
      school: team.school,
      total: team.total,
      rank: team.rank,
      status: team.status,
    })),
  };
}

export interface ResultRow {
  id: string;
  division: string;
  name: string;
  team: string;
  school: string;
  roundAverages: (number | null)[];
  total: number | null;
  average: number | null;
  spread: number | null;
  rank: number | null;
  /** Plain words: "ready" or "can't be scored yet". */
  status: string;
  provisional: "yes" | "no";
}

/** One row per debater, ranked first, then unranked in name order. */
export function resultRows(results: DivisionResultsLike, provisional = true): ResultRow[] {
  return [...results.debaters].sort(byRankThenName).map((debater) => ({
    id: debater.id,
    division: results.divisionCode,
    name: debater.name,
    team: debater.teamName,
    school: debater.school ?? "",
    roundAverages: [...debater.roundAverages],
    total: debater.total,
    average: debater.average,
    spread: debater.spread,
    rank: debater.rank,
    status: resultStatusWords(debater.status),
    provisional: provisional ? "yes" : "no",
  }));
}

export interface TeamResultRow {
  id: string;
  division: string;
  code: string;
  team: string;
  school: string;
  total: number | null;
  rank: number | null;
  /** Plain words: "ready", "can't be scored yet" or "fewer than two debaters". */
  status: string;
  provisional: "yes" | "no";
}

/** One row per team, ranked first, then unranked in name order. */
export function teamResultRows(results: DivisionResultsLike, provisional = true): TeamResultRow[] {
  return [...results.teams].sort(byRankThenName).map((team) => ({
    id: team.id,
    division: results.divisionCode,
    code: team.code ?? "",
    team: team.name,
    school: team.school ?? "",
    total: team.total,
    rank: team.rank,
    status: resultStatusWords(team.status),
    provisional: provisional ? "yes" : "no",
  }));
}

// ---------------------------------------------------------------------------
// Raw scores and feedback

/** One judge's slot with the sheet received for it, if any. */
export interface SheetRecord {
  assignment: Assignment;
  sheet: {
    payload: SheetPayload;
    /** Where the sheet came from, e.g. "judge", "paper", "simulation". */
    source: string;
    /** ISO timestamp when the tournament received it. */
    receivedAt: string;
  } | null;
}

export interface RawScoreRow {
  division: string;
  round: number;
  room: string;
  judge: string;
  debaterId: string;
  debater: string;
  team: string;
  /** The role the debater spoke in, after any side flip or role swap. */
  role: string;
  argumentation: number | null;
  rebuttal: number | null;
  presentation: number | null;
  poi: number | null;
  overall: number | null;
  www: string;
  ebi: string;
  /** "missing" when no sheet has arrived. */
  source: string;
  receivedAt: string;
}

/**
 * One row per debater per judge slot, blank where the sheet is missing.
 * Rows follow the order of `records`, then speaking order within a sheet.
 */
export function rawScoreRows(
  records: SheetRecord[],
  divisionCode?: string,
  roles: RoleLabels = DEFAULT_ROLE_LABELS,
): RawScoreRow[] {
  return records
    .filter((record) => !divisionCode || record.assignment.identity.divisionCode === divisionCode)
    .flatMap((record) => {
      const { identity, display } = record.assignment;
      return speakersInSpeakingOrder(record).map((speaker) => {
        const score = record.sheet?.payload.scores[speaker.id];
        return {
          division: identity.divisionCode,
          round: identity.round,
          room: display.roomName,
          judge: display.judgeName,
          debaterId: speaker.id,
          debater: speaker.name,
          team: teamName(record.assignment, speaker.teamId),
          role: roleLabel(
            spokenRole(record, speaker.teamId, speaker.side, speaker.position),
            roles,
          ),
          argumentation: score?.argumentation ?? null,
          rebuttal: score?.rebuttal ?? null,
          presentation: score?.presentation ?? null,
          poi: score?.poi ?? null,
          overall: score?.overall ?? null,
          www: score?.www ?? "",
          ebi: score?.ebi ?? "",
          source: record.sheet?.source ?? "missing",
          receivedAt: record.sheet?.receivedAt ?? "",
        };
      });
    });
}

export interface FeedbackRow {
  division: string;
  school: string;
  team: string;
  debaterId: string;
  debater: string;
  round: number;
  role: string;
  opponent: string;
  room: string;
  judge: string;
  overall: number | null;
  www: string;
  ebi: string;
}

/**
 * One row per debater per round per judge who sent a sheet, grouped by
 * school, team and debater so a school pack prints in order.
 */
export function feedbackRows(
  records: SheetRecord[],
  divisionCode?: string,
  roles: RoleLabels = DEFAULT_ROLE_LABELS,
): FeedbackRow[] {
  const rows: FeedbackRow[] = [];
  for (const record of records) {
    if (!record.sheet) continue;
    if (divisionCode && record.assignment.identity.divisionCode !== divisionCode) continue;
    const { identity, display } = record.assignment;
    for (const speaker of display.speakers) {
      const score = record.sheet.payload.scores[speaker.id];
      const opponentTeamId =
        speaker.teamId === display.government.teamId
          ? display.opposition.teamId
          : display.government.teamId;
      rows.push({
        division: identity.divisionCode,
        school: teamSchool(record.assignment, speaker.teamId),
        team: teamName(record.assignment, speaker.teamId),
        debaterId: speaker.id,
        debater: speaker.name,
        round: identity.round,
        role: roleLabel(spokenRole(record, speaker.teamId, speaker.side, speaker.position), roles),
        opponent: teamName(record.assignment, opponentTeamId),
        room: display.roomName,
        judge: display.judgeName,
        overall: score?.overall ?? null,
        www: score?.www ?? "",
        ebi: score?.ebi ?? "",
      });
    }
  }
  return rows.sort(
    (a, b) =>
      compareText(a.school, b.school) ||
      compareText(a.team, b.team) ||
      compareText(a.debater, b.debater) ||
      a.round - b.round ||
      compareText(a.judge, b.judge),
  );
}

// ---------------------------------------------------------------------------
// Helpers

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function roomOrder(rooms: Map<string, { sortOrder: number }>, roomId: string): number {
  return rooms.get(roomId)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
}

function speakerName(team: Team, position: 1 | 2): string {
  return team.speakers.find((speaker) => speaker.position === position)?.name ?? "";
}

function byRankThenName(
  a: { rank: number | null; name: string },
  b: { rank: number | null; name: string },
) {
  if (a.rank !== null && b.rank !== null) return a.rank - b.rank || compareText(a.name, b.name);
  if (a.rank !== null) return -1;
  if (b.rank !== null) return 1;
  return compareText(a.name, b.name);
}

function teamName(assignment: Assignment, teamId: string): string {
  const { government, opposition } = assignment.display;
  if (government.teamId === teamId) return government.name;
  if (opposition.teamId === teamId) return opposition.name;
  return teamId;
}

function teamSchool(assignment: Assignment, teamId: string): string {
  const { government, opposition } = assignment.display;
  if (government.teamId === teamId) return government.school;
  if (opposition.teamId === teamId) return opposition.school;
  return "";
}

/** The role a debater spoke in, after the sheet's side flip and role swap. */
function spokenRole(record: SheetRecord, teamId: string, drawnSide: Side, position: 1 | 2) {
  const payload = record.sheet?.payload;
  const side = actualSide(drawnSide, payload?.sideFlipped ?? false);
  return roleFor(side, position, payload?.roleSwaps[teamId] ?? false);
}

/** Speakers ordered PM, LO, GM, OM as they actually spoke. */
function speakersInSpeakingOrder(record: SheetRecord) {
  const order = ["pm", "lo", "gm", "om"];
  return [...record.assignment.display.speakers].sort(
    (a, b) =>
      order.indexOf(spokenRole(record, a.teamId, a.side, a.position)) -
      order.indexOf(spokenRole(record, b.teamId, b.side, b.position)),
  );
}
