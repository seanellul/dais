/**
 * Results for one division: every debater scored, ranks over the debaters
 * who are ready, teams keyed by id, ties, the top-N selection for the final
 * and a completeness report that says what still stands in the way of
 * publishing.
 *
 * `computeDivisionResults` is the only function the app layer calls. It is
 * pure and deterministic: the same input always gives the same output.
 */

import {
  scoreDebater,
  type DebaterInput,
  type DebaterResult,
  type Override,
  type ScoreSource,
} from "./debater";
import { describePolicy } from "./describe";
import type { LoppingPolicy } from "./policy";
import { findTies, rankEq, tiedWith } from "./rank";

export interface TeamInput {
  id: string;
  code: string;
  name: string;
  school: string;
  debaterIds: string[];
}

/** One judge's sheet that the draw says should exist. */
export interface ExpectedSheet {
  assignmentId: string;
  round: number;
  judgeId: string;
  judgeName: string;
  roomName: string;
  /** Every debater the sheet scores (both teams in the room). */
  debaterIds: string[];
  received: boolean;
  /** True when the draw changed and this sheet no longer belongs to a live debate. */
  orphaned?: boolean;
}

export interface DivisionInput {
  divisionId: string;
  /** The rounds every debater is expected to speak in, e.g. [1, 2, 3]. */
  rounds: number[];
  debaters: DebaterInput[];
  teams: TeamInput[];
  expectedSheets: ExpectedSheet[];
  /**
   * Scores from live sheets only; the caller leaves out orphaned sheets. One
   * row per sheet and debater is expected; when several versions of a sheet
   * are passed, the highest `sheetVersion` wins.
   */
  scores: ScoreSource[];
  overrides: Override[];
  policy: LoppingPolicy;
  /** How many teams go through to the final (2 for the Open final). */
  topN: number;
}

export type TeamStatus = "ready" | "unresolved" | "incomplete";

export interface TeamResult {
  id: string;
  code: string;
  name: string;
  school: string;
  members: string[];
  total: number | null;
  rank: number | null;
  tiedWith: string[];
  /**
   * "unresolved": a member can't be scored yet, or the organiser took every
   * member out of the ranking. "incomplete": only one debater counts (the
   * other is missing or was taken out) and no `rank_single_speaker_team`
   * override says how to rank the team.
   */
  status: TeamStatus;
  reasons: string[];
  provisional: boolean;
}

export interface UnrankedEntry {
  id: string;
  reasons: string[];
}

export interface Ranking {
  /** Debater ids in rank order (ties keep input order). */
  rankedDebaters: string[];
  unrankedDebaters: UnrankedEntry[];
  rankedTeams: string[];
  unrankedTeams: UnrankedEntry[];
}

export interface Tie {
  scope: "debater" | "team";
  rank: number;
  ids: string[];
}

export interface TopSelection {
  n: number;
  /** The teams that are certainly through. Fewer than `n` when a tie sits on the cut. */
  teamIds: string[];
  /** True when exactly `n` teams are through, nothing is provisional and no team is still waiting. */
  resolved: boolean;
  /** The teams sharing the rank at the cut, when more than `n` would go through. */
  tieAtCut: { rank: number; teamIds: string[] } | null;
}

export interface MissingSheet {
  assignmentId: string;
  judgeName: string;
  round: number;
  roomName: string;
  waived: boolean;
}

export interface Completeness {
  expected: number;
  received: number;
  missing: MissingSheet[];
  /** Assignment ids of sheets the draw left behind; not counted as expected. */
  orphaned: string[];
  /** True while any expected sheet is missing and not waived. */
  provisional: boolean;
  finalizable: boolean;
  /** Plain-English list of what stands in the way of publishing. */
  blockers: string[];
}

export interface DivisionResults {
  policy: LoppingPolicy;
  policyText: string;
  debaters: DebaterResult[];
  teams: TeamResult[];
  ranking: Ranking;
  ties: Tie[];
  top: TopSelection;
  completeness: Completeness;
}

interface SheetReport {
  expected: number;
  received: number;
  missing: MissingSheet[];
  orphaned: string[];
  /** Rounds with an unwaived missing sheet, per debater. */
  missingRoundsByDebater: Map<string, Set<number>>;
}

/** Count the sheets the draw expects and list the ones still missing. */
function assessSheets(input: DivisionInput): SheetReport {
  const waived = new Set(
    input.overrides
      .filter((o) => o.kind === "waive_missing_sheet" && o.assignmentId)
      .map((o) => o.assignmentId),
  );
  const live = input.expectedSheets.filter((sheet) => !sheet.orphaned);
  const missingRoundsByDebater = new Map<string, Set<number>>();
  const missing: MissingSheet[] = [];
  for (const sheet of live) {
    if (sheet.received) continue;
    const isWaived = waived.has(sheet.assignmentId);
    missing.push({
      assignmentId: sheet.assignmentId,
      judgeName: sheet.judgeName,
      round: sheet.round,
      roomName: sheet.roomName,
      waived: isWaived,
    });
    if (isWaived) continue;
    for (const debaterId of sheet.debaterIds) {
      const rounds = missingRoundsByDebater.get(debaterId) ?? new Set<number>();
      rounds.add(sheet.round);
      missingRoundsByDebater.set(debaterId, rounds);
    }
  }
  return {
    expected: live.length,
    received: live.filter((sheet) => sheet.received).length,
    missing,
    orphaned: input.expectedSheets.filter((s) => s.orphaned).map((s) => s.assignmentId),
    missingRoundsByDebater,
  };
}

function scoreAll(input: DivisionInput, sheets: SheetReport): DebaterResult[] {
  const scoresByDebater = new Map<string, ScoreSource[]>();
  for (const score of input.scores) {
    const list = scoresByDebater.get(score.debaterId) ?? [];
    list.push(score);
    scoresByDebater.set(score.debaterId, list);
  }
  return input.debaters.map((debater) => {
    const missingRounds = sheets.missingRoundsByDebater.get(debater.id);
    return scoreDebater(
      debater,
      input.rounds,
      scoresByDebater.get(debater.id) ?? [],
      input.overrides,
      input.policy,
      { missingRounds: [...(missingRounds ?? [])], provisional: missingRounds !== undefined },
    );
  });
}

/** RANK.EQ over the ready debaters; the others keep `rank: null`. */
function rankDebaters(debaters: DebaterResult[]): DebaterResult[] {
  const ids = debaters.map((d) => d.id);
  const ranks = rankEq(debaters.map((d) => d.total));
  return debaters.map((debater, index) => ({
    ...debater,
    rank: ranks[index],
    tiedWith: tiedWith(debater.id, ids, ranks),
  }));
}

/** Debaters in input order who belong to the team, by teamId or by the team's list. */
function membersOf(team: TeamInput, debaters: DebaterResult[]): DebaterResult[] {
  const listed = new Set(team.debaterIds);
  return debaters.filter((d) => d.teamId === team.id || listed.has(d.id));
}

/** True when the organiser took this debater out of the ranking. */
const isExcluded = (member: DebaterResult): boolean =>
  member.overrides.some((o) => o.kind === "exclude_debater");

const ONE_DEBATER =
  "Only one debater on this team. The organiser can rank it on that one total or leave it unranked.";

/**
 * Build one team from its members. A member the organiser took out of the
 * ranking does not count towards the total, so the team then has one counted
 * debater and `rank_single_speaker_team` decides whether it is ranked on that
 * debater alone.
 */
function buildTeam(team: TeamInput, members: DebaterResult[], overrides: Override[]): TeamResult {
  const base = {
    id: team.id,
    code: team.code,
    name: team.name,
    school: team.school,
    members: members.map((m) => m.id),
    rank: null,
    tiedWith: [],
    provisional: members.some((m) => m.provisional),
  };
  const excluded = members.filter(isExcluded);
  const counted = members.filter((m) => !isExcluded(m));
  const waiting = counted.filter((m) => m.status !== "ready");
  const singleAllowed = overrides.some(
    (o) => o.kind === "rank_single_speaker_team" && o.teamId === team.id,
  );
  const oneDebater = counted.length === 1 && !singleAllowed;
  const reasons = [
    ...excluded.map((m) => `${m.name} was taken out of the ranking by the organiser.`),
    ...waiting.map((m) => `${m.name} can't be scored yet.`),
  ];
  if (members.length === 0) reasons.push("No debaters on this team.");
  else if (oneDebater) reasons.push(ONE_DEBATER);

  if (waiting.length > 0) return { ...base, total: null, status: "unresolved", reasons };
  // Every debater taken out is an organiser decision, so it is not a blocker.
  if (members.length > 0 && counted.length === 0) {
    return { ...base, total: null, status: "unresolved", reasons };
  }
  if (members.length === 0 || oneDebater) {
    return { ...base, total: null, status: "incomplete", reasons };
  }
  let total = 0;
  for (const member of counted) total += member.total ?? 0;
  return { ...base, total, status: "ready", reasons };
}

function rankTeams(teams: TeamResult[]): TeamResult[] {
  const ids = teams.map((t) => t.id);
  const ranks = rankEq(teams.map((t) => t.total));
  return teams.map((team, index) => ({
    ...team,
    rank: ranks[index],
    tiedWith: tiedWith(team.id, ids, ranks),
  }));
}

/** Ids in rank order; a stable sort keeps input order inside a tie. */
function inRankOrder<T extends { id: string; rank: number | null }>(items: T[]): string[] {
  return items
    .filter((item) => item.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((item) => item.id);
}

function unranked<T extends { id: string; rank: number | null; reasons: string[] }>(
  items: T[],
): UnrankedEntry[] {
  return items.filter((item) => item.rank === null).map(({ id, reasons }) => ({ id, reasons }));
}

function collectTies(debaters: DebaterResult[], teams: TeamResult[]): Tie[] {
  const debaterTies = findTies(
    debaters.map((d) => d.id),
    debaters.map((d) => d.rank),
  ).map((group) => ({ scope: "debater" as const, ...group }));
  const teamTies = findTies(
    teams.map((t) => t.id),
    teams.map((t) => t.rank),
  ).map((group) => ({ scope: "team" as const, ...group }));
  return [...debaterTies, ...teamTies];
}

/**
 * The teams that go through to the final. When the nth and (n+1)th teams
 * share a rank, only the teams above that rank are certain and `tieAtCut`
 * names the teams the organiser must decide between. There is no automatic
 * tie-break: the organiser confirms the finalists with a reason.
 */
export function selectTop(teams: TeamResult[], n: number): TopSelection {
  if (n <= 0) return { n, teamIds: [], resolved: true, tieAtCut: null };
  // A team that is still waiting for a sheet, a score or the organiser's
  // decision could still move the cut, so the selection is not settled.
  const settled = !teams.some((t) => t.status !== "ready" || t.provisional);
  const ranked = teams.filter((t) => t.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (ranked.length < n) {
    return { n, teamIds: ranked.map((t) => t.id), resolved: false, tieAtCut: null };
  }
  const cutRank = ranked[n - 1].rank ?? 0;
  const above = ranked.filter((t) => (t.rank ?? 0) < cutRank);
  const atCut = ranked.filter((t) => t.rank === cutRank);
  if (above.length + atCut.length > n) {
    return {
      n,
      teamIds: above.map((t) => t.id),
      resolved: false,
      tieAtCut: { rank: cutRank, teamIds: atCut.map((t) => t.id) },
    };
  }
  return { n, teamIds: ranked.slice(0, n).map((t) => t.id), resolved: settled, tieAtCut: null };
}

/** True when the only thing missing is a sheet, which is already a blocker of its own. */
const onlyWaitingForSheets = (debater: DebaterResult): boolean =>
  debater.rounds.every((round) => round.status === "ready" || round.status === "missing");

/**
 * Everything that must be dealt with before the results can be published.
 * Each problem is listed once: a missing sheet is one line, not one line per
 * debater it covers, and an organiser decision is not a problem at all.
 */
function collectBlockers(
  missing: MissingSheet[],
  debaters: DebaterResult[],
  teams: TeamResult[],
): string[] {
  const blockers: string[] = [];
  for (const sheet of missing) {
    if (sheet.waived) continue;
    blockers.push(
      `Round ${sheet.round}, ${sheet.roomName}: the sheet from ${sheet.judgeName} has not been received by the tournament.`,
    );
  }
  for (const debater of debaters) {
    if (debater.status === "ready" || isExcluded(debater)) continue;
    if (onlyWaitingForSheets(debater)) continue;
    blockers.push(`${debater.name} can't be scored yet. ${debater.reasons.join(" ")}`.trim());
  }
  for (const team of teams) {
    if (team.status !== "incomplete") continue;
    blockers.push(`${team.name} (${team.code}): ${team.reasons.join(" ")}`);
  }
  return blockers;
}

/** Score, rank and check one division. */
export function computeDivisionResults(input: DivisionInput): DivisionResults {
  const sheets = assessSheets(input);
  const debaters = rankDebaters(scoreAll(input, sheets));
  const teams = rankTeams(
    input.teams.map((team) => buildTeam(team, membersOf(team, debaters), input.overrides)),
  );
  const blockers = collectBlockers(sheets.missing, debaters, teams);
  return {
    policy: input.policy,
    policyText: describePolicy(input.policy),
    debaters,
    teams,
    ranking: {
      rankedDebaters: inRankOrder(debaters),
      unrankedDebaters: unranked(debaters),
      rankedTeams: inRankOrder(teams),
      unrankedTeams: unranked(teams),
    },
    ties: collectTies(debaters, teams),
    top: selectTop(teams, input.topN),
    completeness: {
      expected: sheets.expected,
      received: sheets.received,
      missing: sheets.missing,
      orphaned: sheets.orphaned,
      provisional: sheets.missing.some((sheet) => !sheet.waived),
      finalizable: blockers.length === 0,
      blockers,
    },
  };
}
