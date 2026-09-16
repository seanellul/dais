/**
 * One debater's result: every judge score they received, which scores were
 * kept or set aside and why, the average per round and the total.
 *
 * Organiser overrides are applied after the policy, so the trace can always
 * show what the policy decided and what the organiser changed.
 */

import type { SpeakerPosition } from "../types";
import { describeExclusion, describePooledEdgeCase, describeRoundReason } from "./describe";
import {
  average,
  lopValues,
  type Boundary,
  type LopEdgeCase,
  type LopResult,
  type LopStats,
} from "./lop";
import type { LoppingPolicy } from "./policy";

/** Where a score came from, for the audit trail and the results trace. */
export type ScoreOrigin =
  "judge" | "judge_handoff" | "organiser_manual" | "organiser_resolution" | "simulation" | "import";

/** One judge's Overall score for one debater in one round. */
export interface ScoreSource {
  assignmentId: string;
  judgeId: string;
  judgeName: string;
  round: number;
  debaterId: string;
  value: number;
  sheetVersion: number;
  source: ScoreOrigin;
}

export type OverrideKind =
  | "force_include"
  | "force_exclude"
  | "keep_all_for_debater"
  | "exclude_debater"
  | "waive_missing_sheet"
  | "rank_single_speaker_team";

/**
 * An organiser decision applied after the policy. Every override carries a
 * reason; the server writes the audit row.
 *
 * - force_include / force_exclude: one score, named by `assignmentId` and
 *   `debaterId`. Both are needed: a sheet scores every debater in the room,
 *   so an override naming only the sheet touches nothing. `round` is optional.
 * - keep_all_for_debater: keep every score of `debaterId`, whatever the policy says.
 * - exclude_debater: take `debaterId` out of the ranking.
 * - waive_missing_sheet: the sheet `assignmentId` will never arrive; stop waiting for it.
 * - rank_single_speaker_team: rank team `teamId` on its single debater's total.
 */
export interface Override {
  id: string;
  kind: OverrideKind;
  debaterId?: string;
  teamId?: string;
  round?: number;
  assignmentId?: string;
  reason: string;
}

export type SourceStatus = "retained" | "lopped" | "forced_in" | "forced_out";

/** A score with the decision made about it. */
export interface SourceOutcome extends ScoreSource {
  status: SourceStatus;
  /** Which pass set the score aside (iterative policies). */
  pass?: number;
  /** Set when the score sits exactly on an edge of the kept range. */
  onBoundary?: Boundary;
  /** The organiser override that touched this score, if any. */
  overrideId?: string;
}

export type RoundStatus = "ready" | "unresolved" | "missing";
export type RoundReason =
  "no_scores" | "no_retained_scores" | "sd_undefined" | "zero_spread" | "sheet_missing";

export interface RoundResult {
  round: number;
  /** Average of the kept scores, or `null` when the round can't be scored yet. */
  average: number | null;
  sources: SourceOutcome[];
  status: RoundStatus;
  reason?: RoundReason;
}

/** Statistics plus the per-pass history (one entry under a one-pass policy). */
export type StatsTrace = LopStats & { passStats: LopStats[] };

export type DebaterStats =
  ({ scope: "pooled" } & StatsTrace) | { scope: "perRound"; byRound: Record<number, StatsTrace> };

export interface DebaterInput {
  id: string;
  name: string;
  teamId: string;
  position: SpeakerPosition;
}

/** What the division knows about sheets that this debater is still waiting for. */
export interface DebaterContext {
  /** Rounds in which an expected sheet covering this debater has not arrived. */
  missingRounds?: number[];
  /** True when any expected sheet covering this debater is missing and not waived. */
  provisional?: boolean;
}

export type DebaterStatus = "ready" | "unresolved";

export interface DebaterResult {
  id: string;
  name: string;
  teamId: string;
  stats: DebaterStats;
  rounds: RoundResult[];
  /** Sum of the round averages, or `null` when the debater can't be scored yet. */
  total: number | null;
  status: DebaterStatus;
  /** Plain-English reasons when the debater can't be scored yet. */
  reasons: string[];
  rank: number | null;
  tiedWith: string[];
  provisional: boolean;
  /** The overrides that touched this debater. */
  overrides: Override[];
}

interface Lopped {
  stats: DebaterStats;
  outcomes: SourceOutcome[];
  /** The pooled edge case, when the policy scope is "pooled" and one applied. */
  pooledEdge?: LopEdgeCase;
  /** Rounds whose kept range could not be built (every round under a pooled edge case). */
  edgeByRound: Map<number, LopEdgeCase>;
}

const DEBATER_OVERRIDES: ReadonlySet<OverrideKind> = new Set([
  "force_include",
  "force_exclude",
  "keep_all_for_debater",
  "exclude_debater",
]);

export const isKept = (outcome: SourceOutcome): boolean =>
  outcome.status === "retained" || outcome.status === "forced_in";

/** What identifies one score: one judge's sheet and one debater on it. */
const scoreKey = (source: ScoreSource): string => `${source.assignmentId}:${source.debaterId}`;

/**
 * One row per sheet and debater. When the caller passes several versions of
 * the same sheet (both versions after a resolution, or a replayed sync), the
 * highest `sheetVersion` wins. A row keeps the position of the first version
 * seen, so the averages still sum in input order.
 */
function latestVersions(sources: ScoreSource[]): ScoreSource[] {
  const latest = new Map<string, ScoreSource>();
  for (const source of sources) {
    const seen = latest.get(scoreKey(source));
    if (!seen || source.sheetVersion > seen.sheetVersion) latest.set(scoreKey(source), source);
  }
  return [...latest.values()];
}

/** This debater's finite scores in the expected rounds, one per sheet, ordered by round. */
function ownSources(debaterId: string, rounds: number[], sources: ScoreSource[]): ScoreSource[] {
  const roundOrder = new Map(rounds.map((round, index) => [round, index]));
  const own = sources.filter(
    (s) => s.debaterId === debaterId && roundOrder.has(s.round) && Number.isFinite(s.value),
  );
  return latestVersions(own).sort(
    (a, b) => (roundOrder.get(a.round) ?? 0) - (roundOrder.get(b.round) ?? 0),
  );
}

function overrideMatchesSource(override: Override, source: ScoreSource): boolean {
  switch (override.kind) {
    case "keep_all_for_debater":
      return override.debaterId === source.debaterId;
    case "force_include":
    case "force_exclude":
      // A sheet scores every debater in the room, so an override without a
      // debaterId would flip four results. It touches nothing instead.
      return (
        override.assignmentId !== undefined &&
        override.debaterId !== undefined &&
        override.assignmentId === source.assignmentId &&
        override.debaterId === source.debaterId &&
        (override.round === undefined || override.round === source.round)
      );
    default:
      return false;
  }
}

/** The overrides that concern this debater's scores or ranking. */
function overridesFor(debaterId: string, overrides: Override[]): Override[] {
  return overrides.filter(
    (override) => DEBATER_OVERRIDES.has(override.kind) && override.debaterId === debaterId,
  );
}

/** Tag each source with the lopping decision. Sources are identified by index. */
function toOutcomes(sources: ScoreSource[], result: LopResult): SourceOutcome[] {
  const loppedById = new Map(result.lopped.map((item) => [item.sourceId, item]));
  return sources.map((source, index) => {
    const lopped = loppedById.get(String(index));
    if (!lopped) return { ...source, status: "retained" };
    return lopped.onBoundary
      ? { ...source, status: "lopped", pass: lopped.pass, onBoundary: lopped.onBoundary }
      : { ...source, status: "lopped", pass: lopped.pass };
  });
}

function runLop(sources: ScoreSource[], policy: LoppingPolicy): LopResult {
  return lopValues(
    sources.map((source, index) => ({ value: source.value, sourceId: String(index) })),
    policy,
  );
}

/** One kept range over every round (the workbook's way). */
function lopPooled(own: ScoreSource[], rounds: number[], policy: LoppingPolicy): Lopped {
  const result = runLop(own, policy);
  const edgeByRound = new Map<number, LopEdgeCase>();
  if (result.reason) for (const round of rounds) edgeByRound.set(round, result.reason);
  return {
    stats: { scope: "pooled", ...result.stats, passStats: result.passStats },
    outcomes: toOutcomes(own, result),
    pooledEdge: result.reason,
    edgeByRound,
  };
}

/** One kept range per round. */
function lopPerRound(own: ScoreSource[], rounds: number[], policy: LoppingPolicy): Lopped {
  const byRound: Record<number, StatsTrace> = {};
  const outcomes: SourceOutcome[] = [];
  const edgeByRound = new Map<number, LopEdgeCase>();
  for (const round of rounds) {
    const inRound = own.filter((source) => source.round === round);
    const result = runLop(inRound, policy);
    byRound[round] = { ...result.stats, passStats: result.passStats };
    if (result.reason) edgeByRound.set(round, result.reason);
    outcomes.push(...toOutcomes(inRound, result));
  }
  return { stats: { scope: "perRound", byRound }, outcomes, edgeByRound };
}

/** Apply one override to one score. Later overrides win over earlier ones. */
function applyOverride(outcome: SourceOutcome, override: Override): SourceOutcome {
  if (!overrideMatchesSource(override, outcome)) return outcome;
  const kept = isKept(outcome);
  switch (override.kind) {
    case "keep_all_for_debater":
      return kept ? outcome : { ...outcome, status: "forced_in", overrideId: override.id };
    case "force_include":
      return kept
        ? { ...outcome, overrideId: override.id }
        : { ...outcome, status: "forced_in", overrideId: override.id };
    case "force_exclude":
      return kept
        ? { ...outcome, status: "forced_out", overrideId: override.id }
        : { ...outcome, overrideId: override.id };
    default:
      return outcome;
  }
}

function applyOverrides(outcomes: SourceOutcome[], overrides: Override[]): SourceOutcome[] {
  return outcomes.map((outcome) => overrides.reduce(applyOverride, outcome));
}

function buildRound(
  round: number,
  outcomes: SourceOutcome[],
  edgeCase: LopEdgeCase | undefined,
  sheetMissing: boolean,
): RoundResult {
  const sources = outcomes.filter((outcome) => outcome.round === round);
  if (sources.length === 0) {
    return sheetMissing
      ? { round, average: null, sources, status: "missing", reason: "sheet_missing" }
      : { round, average: null, sources, status: "unresolved", reason: "no_scores" };
  }
  const kept = sources.filter(isKept).map((outcome) => outcome.value);
  if (kept.length === 0) {
    return {
      round,
      average: null,
      sources,
      status: "unresolved",
      reason: edgeCase ?? "no_retained_scores",
    };
  }
  return { round, average: average(kept), sources, status: "ready" };
}

function sumAverages(rounds: RoundResult[]): number {
  let total = 0;
  for (const round of rounds) total += round.average ?? 0;
  return total;
}

/** Plain-English reasons, one per distinct problem, in round order. */
function collectReasons(
  rounds: RoundResult[],
  pooledEdge: LopEdgeCase | undefined,
  exclusion: Override | undefined,
): string[] {
  const reasons: string[] = [];
  if (exclusion) reasons.push(describeExclusion(exclusion.reason));
  const pooledEdgeApplies = rounds.some((round) => round.reason === pooledEdge);
  if (pooledEdge && pooledEdgeApplies) reasons.push(describePooledEdgeCase(pooledEdge));
  for (const round of rounds) {
    if (round.status === "ready" || !round.reason) continue;
    if (round.reason === pooledEdge) continue; // already said once for the whole debater
    reasons.push(describeRoundReason(round.round, round.reason));
  }
  return reasons;
}

/**
 * Score one debater.
 *
 * Pooled scope runs one `lopValues` over every score and then partitions the
 * outcomes per round; per-round scope runs `lopValues` per round. Overrides
 * are applied afterwards. The result has no rank yet: ranks are assigned by
 * `computeDivisionResults` once every debater is scored.
 */
export function scoreDebater(
  debater: DebaterInput,
  rounds: number[],
  sources: ScoreSource[],
  overrides: Override[],
  policy: LoppingPolicy,
  context: DebaterContext = {},
): DebaterResult {
  const own = ownSources(debater.id, rounds, sources);
  const mine = overridesFor(debater.id, overrides);
  const lopped =
    policy.scope === "pooled" ? lopPooled(own, rounds, policy) : lopPerRound(own, rounds, policy);
  const outcomes = applyOverrides(lopped.outcomes, mine);
  const missing = new Set(context.missingRounds ?? []);
  const roundResults = rounds.map((round) =>
    buildRound(round, outcomes, lopped.edgeByRound.get(round), missing.has(round)),
  );
  const exclusion = mine.find((override) => override.kind === "exclude_debater");
  const ready = exclusion === undefined && roundResults.every((round) => round.status === "ready");
  return {
    id: debater.id,
    name: debater.name,
    teamId: debater.teamId,
    stats: lopped.stats,
    rounds: roundResults,
    total: ready ? sumAverages(roundResults) : null,
    status: ready ? "ready" : "unresolved",
    reasons: collectReasons(roundResults, lopped.pooledEdge, exclusion),
    rank: null,
    tiedWith: [],
    provisional: context.provisional ?? false,
    overrides: mine,
  };
}
