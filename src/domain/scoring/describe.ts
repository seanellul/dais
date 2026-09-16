/**
 * Plain-English text for the scoring engine, in the tournament's vocabulary:
 * average (not mean), spread (not standard deviation), kept range (not
 * bounds), set aside (not lopped), can't be scored yet (not unresolved).
 */

import type { LopEdgeCase } from "./lop";
import type { LoppingPolicy } from "./policy";

/** "2" for 2, "1.5" for 1.5. */
function formatMultiplier(multiplier: number): string {
  return Number.isInteger(multiplier) ? String(multiplier) : String(Number(multiplier.toFixed(3)));
}

function describeEdgeRules(policy: LoppingPolicy): string {
  const fewScores = "fewer than two scores";
  const sameScores = "every score the same";
  const outcome = (rule: LoppingPolicy["whenUndefined"]): string =>
    rule === "keepAll" ? "keeps all of them" : "can't be scored yet";
  if (policy.whenUndefined === policy.zeroSpread) {
    return `a debater with ${fewScores} or with ${sameScores} ${outcome(policy.whenUndefined)}`;
  }
  return (
    `a debater with ${fewScores} ${outcome(policy.whenUndefined)}, ` +
    `and a debater with ${sameScores} ${outcome(policy.zeroSpread)}`
  );
}

/** One sentence that tells an organiser exactly how scores are set aside. */
export function describePolicy(policy: LoppingPolicy): string {
  const scope =
    policy.scope === "pooled"
      ? "all of a debater's scores from every round"
      : "each round's scores separately";
  const spreadKind = policy.sd === "sample" ? "sample spread" : "population spread";
  const rounding = policy.excelCriteriaRounding
    ? ", rounded to 15 significant digits as Excel does"
    : "";
  const range = `average ± ${formatMultiplier(policy.sdMultiplier)} × spread${rounding}`;
  const edge = policy.bounds === "strict" ? "on or outside" : "outside";
  const passes =
    policy.passes === "one" ? "once" : "again and again until nothing more is set aside";
  return (
    `The average and ${spreadKind} are taken over ${scope}; ` +
    `scores ${edge} the kept range (${range}) are set aside ${passes}; ` +
    `${describeEdgeRules(policy)}.`
  );
}

export type RoundReasonCode =
  "no_scores" | "no_retained_scores" | "sd_undefined" | "zero_spread" | "sheet_missing";

/** Why one round of a debater's results has no average. */
export function describeRoundReason(round: number, reason: RoundReasonCode): string {
  switch (reason) {
    case "no_scores":
      return `Round ${round}: no scores have been received yet.`;
    case "sheet_missing":
      return `Round ${round}: a sheet has not been received by the tournament yet.`;
    case "no_retained_scores":
      return `Round ${round}: every score was set aside, so there is nothing to average.`;
    case "sd_undefined":
      return `Round ${round}: fewer than two scores, so there is no spread to check.`;
    case "zero_spread":
      return `Round ${round}: every score is the same, so the spread is zero and the kept range keeps nothing.`;
  }
}

/** Why a debater's pooled kept range could not be built. */
export function describePooledEdgeCase(edgeCase: LopEdgeCase): string {
  return edgeCase === "sd_undefined"
    ? "Fewer than two scores across all rounds, so there is no spread to check."
    : "Every score across all rounds is the same, so the spread is zero and the kept range keeps nothing.";
}

/** The organiser took this debater out of the ranking. */
export function describeExclusion(reason: string): string {
  return `Set aside from the ranking by the organiser: ${reason}`;
}
