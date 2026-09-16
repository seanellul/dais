/**
 * Results for one division, ready for the results page.
 *
 * The scoring engine (`computeDivisionResults`) does the arithmetic and
 * explains itself in plain words. This module feeds it the right policy
 * (the snapshot stamped on a published division, otherwise the tournament's
 * current policy) and dresses the output with names: which judge's score
 * was set aside, which room a missing sheet belongs to, which team a
 * debater is on. Nothing here changes a number.
 */
import { z } from "zod";

import { resultStatusWords } from "@/domain/export";
import {
  computeDivisionResults,
  describeRoundReason,
  isKept,
  type DebaterResult,
  type DivisionResults,
  type LoppingPolicy,
  type Override,
  type Ranking,
  type RoundResult,
  type ScoreOrigin,
  type SourceOutcome,
  type SourceStatus,
  type TeamResult,
  type Tie,
} from "@/domain/scoring";
import type { SpeakerPosition } from "@/domain/types";
import type { DivisionRow, TournamentRow } from "@/server/db";
import { errors } from "@/server/errors";

import type { Queryable } from "./context";
import { loadGraph, toDivisionInput, type TournamentGraph } from "./graph";

// ---------------------------------------------------------------------------
// Policy

const policySchema = z.object({
  sdMultiplier: z.number().min(0),
  bounds: z.enum(["strict", "inclusive"]),
  scope: z.enum(["pooled", "perRound"]),
  passes: z.enum(["one", "iterative"]),
  sd: z.enum(["sample", "population"]),
  whenUndefined: z.enum(["unresolved", "keepAll"]),
  zeroSpread: z.enum(["unresolved", "keepAll"]),
  excelCriteriaRounding: z.boolean(),
});

/**
 * The outlier policy stored as jsonb, checked field by field. A row that
 * fails is corrupt data, not user input, so it is an internal error with the
 * offending paths in the message (and therefore in the log).
 */
export function parseScoringPolicy(json: unknown, where = "tournament"): LoppingPolicy {
  const parsed = policySchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");
  throw errors.internal(new Error(`The ${where} scoring policy is invalid: ${detail}`));
}

/**
 * The policy a division is scored under: the snapshot taken when its
 * results were published, so a later policy edit can never change a
 * published result; otherwise the tournament's current policy.
 */
export function policyFor(
  tournament: Pick<TournamentRow, "scoringPolicy">,
  division: Pick<DivisionRow, "code" | "finalizedAt" | "policySnapshot">,
): LoppingPolicy {
  if (division.finalizedAt !== null && division.policySnapshot !== null) {
    return parseScoringPolicy(division.policySnapshot, `${division.code} division snapshot`);
  }
  return parseScoringPolicy(tournament.scoringPolicy);
}

// ---------------------------------------------------------------------------
// The view

/** One judge's score for one debater in one round, with the decision about it. */
export interface ScoreCell {
  assignmentId: string;
  judgeId: string;
  judgeName: string;
  value: number;
  sheetVersion: number;
  source: ScoreOrigin;
  status: SourceStatus;
  kept: boolean;
  /** "kept", "set aside", "kept by the organiser" or "set aside by the organiser". */
  label: string;
  overrideId?: string;
}

export interface RoundCell {
  round: number;
  average: number | null;
  status: RoundResult["status"];
  /** Plain words when the round has no average. */
  reason?: string;
  scores: ScoreCell[];
  /** "Marisol 84 · Cedric 82 · Priya 45 (set aside)". */
  trace: string;
  /** The round's own kept range under a per-round policy. */
  range?: KeptRange;
}

export interface KeptRange {
  average: number | null;
  spread: number | null;
  lower: number | null;
  upper: number | null;
}

export interface DebaterView {
  id: string;
  name: string;
  position: SpeakerPosition;
  teamId: string;
  teamCode: string;
  teamName: string;
  school: string;
  rank: number | null;
  tiedWith: string[];
  total: number | null;
  status: DebaterResult["status"];
  /** "ready" or "can't be scored yet". */
  statusWords: string;
  provisional: boolean;
  /** Plain-English reasons when the debater can't be scored yet. */
  reasons: string[];
  rounds: RoundCell[];
  /** The pooled kept range; every field null under a per-round policy. */
  range: KeptRange & { scope: "pooled" | "perRound" };
  overrides: Override[];
}

export interface TeamMemberView {
  id: string;
  name: string;
  total: number | null;
  rank: number | null;
}

export interface TeamView {
  id: string;
  code: string;
  name: string;
  school: string;
  rank: number | null;
  tiedWith: string[];
  total: number | null;
  status: TeamResult["status"];
  /** "ready", "can't be scored yet" or "fewer than two debaters". */
  statusWords: string;
  provisional: boolean;
  reasons: string[];
  members: TeamMemberView[];
}

/** A score the policy or the organiser set aside, with the judge named. */
export interface SetAsideView {
  debaterId: string;
  debaterName: string;
  teamCode: string;
  round: number;
  assignmentId: string;
  judgeId: string;
  judgeName: string;
  value: number;
  byOrganiser: boolean;
  overrideId?: string;
  /** "Set aside: 45 from Priya Nair in round 2 sits outside the kept range." */
  sentence: string;
}

export interface MissingSheetView {
  assignmentId: string;
  judgeId: string;
  judgeName: string;
  roomName: string;
  round: number;
  waived: boolean;
  waiverReason?: string;
}

export interface TeamSummary {
  id: string;
  code: string;
  name: string;
  school: string;
}

export interface FinalistsView {
  n: number;
  teams: TeamSummary[];
  resolved: boolean;
  tieAtCut: { rank: number; teams: TeamSummary[] } | null;
}

export interface CompletenessView {
  expected: number;
  received: number;
  missing: MissingSheetView[];
  /** Assignment ids of sheets the draw left behind (old draw). */
  orphaned: string[];
  provisional: boolean;
  finalizable: boolean;
  blockers: string[];
}

export interface DivisionResultsView {
  tournamentId: string;
  divisionCode: string;
  divisionName: string;
  /** Set once results are published. */
  published: { at: string; by: string | null } | null;
  policy: LoppingPolicy;
  policyText: string;
  debaters: DebaterView[];
  teams: TeamView[];
  ranking: Ranking;
  ties: Tie[];
  finalists: FinalistsView;
  setAside: SetAsideView[];
  completeness: CompletenessView;
  /** Open two-versions cases in the division, which block publishing. */
  openConflicts: number;
  /** The engine's own output, for exports and tests. */
  results: DivisionResults;
}

/** Loads the tournament and builds the results view for one division. */
export async function divisionResults(
  db: Queryable,
  tournamentId: string,
  divisionCode: string,
): Promise<DivisionResultsView> {
  const graph = await loadGraph(db, tournamentId);
  return buildResultsView(graph, divisionCode);
}

/**
 * The results view from a loaded graph (pure). Publishing uses this inside
 * its transaction so the numbers it checks are the numbers it publishes.
 */
export function buildResultsView(
  graph: TournamentGraph,
  divisionCode: string,
): DivisionResultsView {
  const division = graph.divisions.find((row) => row.code === divisionCode);
  if (!division) throw errors.notFound("That division");
  const policy = policyFor(graph.tournament, division);
  const results = computeDivisionResults(toDivisionInput(graph, divisionCode, policy));
  const names = new Names(graph);

  const debaters = results.debaters.map((debater) => toDebaterView(debater, names));
  const teams = results.teams.map((team) => toTeamView(team, results.debaters));
  return {
    tournamentId: graph.tournament.id,
    divisionCode,
    divisionName: division.name,
    published:
      division.finalizedAt === null
        ? null
        : { at: division.finalizedAt.toISOString(), by: division.finalizedBy },
    policy,
    policyText: results.policyText,
    debaters,
    teams,
    ranking: results.ranking,
    ties: results.ties,
    finalists: toFinalists(results, names),
    setAside: collectSetAside(results.debaters, names),
    completeness: {
      ...results.completeness,
      missing: results.completeness.missing.map((sheet) => ({
        assignmentId: sheet.assignmentId,
        judgeId: names.judgeIdOf(sheet.assignmentId),
        judgeName: sheet.judgeName,
        roomName: sheet.roomName,
        round: sheet.round,
        waived: sheet.waived,
        ...(sheet.waived ? { waiverReason: names.waiverReason(sheet.assignmentId) } : {}),
      })),
    },
    openConflicts: names.openConflictsIn(divisionCode),
    results,
  };
}

// ---------------------------------------------------------------------------
// Names and lookups

/** Lookups from the graph, built once per view. */
class Names {
  private readonly teamsById = new Map<string, TeamSummary>();
  private readonly speakerTeam = new Map<string, { teamId: string; position: SpeakerPosition }>();
  private readonly judgeByAssignment = new Map<string, string>();
  private readonly divisionByAssignment = new Map<string, string>();
  private readonly waivers = new Map<string, string>();

  constructor(private readonly graph: TournamentGraph) {
    for (const team of graph.teams) {
      this.teamsById.set(team.id, {
        id: team.id,
        code: team.code,
        name: team.name,
        school: team.school,
      });
    }
    for (const speaker of graph.speakers) {
      this.speakerTeam.set(speaker.id, {
        teamId: speaker.teamId,
        position: speaker.position === 1 ? 1 : 2,
      });
    }
    const divisionOfDebate = new Map(graph.debates.map((d) => [d.id, d.divisionCode]));
    for (const assignment of graph.assignments) {
      this.judgeByAssignment.set(assignment.id, assignment.judgeId);
      this.divisionByAssignment.set(
        assignment.id,
        divisionOfDebate.get(assignment.debateId) ?? assignment.identity.divisionCode,
      );
    }
    for (const waiver of graph.sheetWaivers) {
      if (waiver.revokedAt === null) this.waivers.set(waiver.assignmentId, waiver.reason);
    }
  }

  team(teamId: string): TeamSummary {
    return this.teamsById.get(teamId) ?? { id: teamId, code: "", name: "Unknown team", school: "" };
  }

  positionOf(speakerId: string): SpeakerPosition {
    return this.speakerTeam.get(speakerId)?.position ?? 1;
  }

  judgeIdOf(assignmentId: string): string {
    return this.judgeByAssignment.get(assignmentId) ?? "";
  }

  waiverReason(assignmentId: string): string | undefined {
    return this.waivers.get(assignmentId);
  }

  openConflictsIn(divisionCode: string): number {
    return this.graph.conflicts.filter(
      (conflict) =>
        conflict.status === "open" &&
        this.divisionByAssignment.get(conflict.assignmentId) === divisionCode,
    ).length;
  }
}

// ---------------------------------------------------------------------------
// Projections

function toDebaterView(debater: DebaterResult, names: Names): DebaterView {
  const team = names.team(debater.teamId);
  const perRound = debater.stats.scope === "perRound" ? debater.stats.byRound : undefined;
  return {
    id: debater.id,
    name: debater.name,
    position: names.positionOf(debater.id),
    teamId: team.id,
    teamCode: team.code,
    teamName: team.name,
    school: team.school,
    rank: debater.rank,
    tiedWith: debater.tiedWith,
    total: debater.total,
    status: debater.status,
    statusWords: resultStatusWords(debater.status),
    provisional: debater.provisional,
    reasons: debater.reasons,
    rounds: debater.rounds.map((round) => ({
      ...toRoundCell(round),
      ...(perRound?.[round.round] ? { range: toRange(perRound[round.round]) } : {}),
    })),
    range:
      debater.stats.scope === "pooled"
        ? { scope: "pooled", ...toRange(debater.stats) }
        : { scope: "perRound", average: null, spread: null, lower: null, upper: null },
    overrides: debater.overrides,
  };
}

function toRange(stats: {
  mean: number | null;
  sd: number | null;
  lower: number | null;
  upper: number | null;
}): KeptRange {
  return { average: stats.mean, spread: stats.sd, lower: stats.lower, upper: stats.upper };
}

function toRoundCell(round: RoundResult): RoundCell {
  const scores = round.sources.map(toScoreCell);
  return {
    round: round.round,
    average: round.average,
    status: round.status,
    ...(round.reason ? { reason: describeRoundReason(round.round, round.reason) } : {}),
    scores,
    trace: scores
      .map((cell) =>
        cell.kept
          ? `${cell.judgeName} ${cell.value}`
          : `${cell.judgeName} ${cell.value} (${cell.label})`,
      )
      .join(" · "),
  };
}

function toScoreCell(source: SourceOutcome): ScoreCell {
  return {
    assignmentId: source.assignmentId,
    judgeId: source.judgeId,
    judgeName: source.judgeName,
    value: source.value,
    sheetVersion: source.sheetVersion,
    source: source.source,
    status: source.status,
    kept: isKept(source),
    label: labelOf(source.status),
    ...(source.overrideId ? { overrideId: source.overrideId } : {}),
  };
}

/** The tournament words for each decision about a score. */
export function labelOf(status: SourceStatus): string {
  switch (status) {
    case "retained":
      return "kept";
    case "lopped":
      return "set aside";
    case "forced_in":
      return "kept by the organiser";
    case "forced_out":
      return "set aside by the organiser";
  }
}

function toTeamView(team: TeamResult, debaters: DebaterResult[]): TeamView {
  const byId = new Map(debaters.map((debater) => [debater.id, debater]));
  return {
    id: team.id,
    code: team.code,
    name: team.name,
    school: team.school,
    rank: team.rank,
    tiedWith: team.tiedWith,
    total: team.total,
    status: team.status,
    statusWords: resultStatusWords(team.status),
    provisional: team.provisional,
    reasons: team.reasons,
    members: team.members.map((id) => {
      const member = byId.get(id);
      return {
        id,
        name: member?.name ?? "",
        total: member?.total ?? null,
        rank: member?.rank ?? null,
      };
    }),
  };
}

function toFinalists(results: DivisionResults, names: Names): FinalistsView {
  return {
    n: results.top.n,
    teams: results.top.teamIds.map((id) => names.team(id)),
    resolved: results.top.resolved,
    tieAtCut:
      results.top.tieAtCut === null
        ? null
        : {
            rank: results.top.tieAtCut.rank,
            teams: results.top.tieAtCut.teamIds.map((id) => names.team(id)),
          },
  };
}

/** Every set-aside score in the division, in debater then round order, each with a sentence. */
function collectSetAside(debaters: DebaterResult[], names: Names): SetAsideView[] {
  const list: SetAsideView[] = [];
  for (const debater of debaters) {
    const team = names.team(debater.teamId);
    for (const round of debater.rounds) {
      for (const source of round.sources) {
        if (isKept(source)) continue;
        const byOrganiser = source.status === "forced_out";
        list.push({
          debaterId: debater.id,
          debaterName: debater.name,
          teamCode: team.code,
          round: round.round,
          assignmentId: source.assignmentId,
          judgeId: source.judgeId,
          judgeName: source.judgeName,
          value: source.value,
          byOrganiser,
          ...(source.overrideId ? { overrideId: source.overrideId } : {}),
          sentence: byOrganiser
            ? `Set aside by the organiser: ${source.value} from ${source.judgeName} in round ${round.round} for ${debater.name}.`
            : `Set aside: ${source.value} from ${source.judgeName} in round ${round.round} sits outside ${debater.name}'s kept range.`,
        });
      }
    }
  }
  return list;
}
