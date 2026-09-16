/**
 * The outlier policy.
 *
 * The tournament rules say that a judge's score sitting far from the other
 * judges' scores for the same debater is set aside before the averages are
 * taken. The director's workbook does this with AVERAGEIFS between
 * mean − 2 × STDEV.S and mean + 2 × STDEV.S, where the mean and the standard
 * deviation are taken over ALL of a debater's scores from every round, and
 * only scores strictly inside that range are kept.
 *
 * Every knob below has a workbook value, so `WORKBOOK_POLICY` reproduces the
 * workbook exactly. Each knob can be changed for a tournament that reads the
 * rules differently. The organiser sees the chosen policy as one sentence
 * (see `describePolicy`) and the policy is stamped on every published result.
 *
 * Internal code says "lop" for "set aside"; user-facing text never does.
 */

/** How a score sitting exactly on the edge of the kept range is treated. */
export type BoundsMode = "strict" | "inclusive";

/** Which scores feed the average and spread that build the kept range. */
export type LoppingScope = "pooled" | "perRound";

/** Whether the check runs once or repeats on the kept scores until stable. */
export type PassMode = "one" | "iterative";

/** Sample spread (STDEV.S, divides by n − 1) or population spread (STDEV.P, divides by n). */
export type SpreadKind = "sample" | "population";

/** What happens when the kept range cannot be built. */
export type EdgeRule = "unresolved" | "keepAll";

export interface LoppingPolicy {
  /** Half-width of the kept range in spreads: average ± sdMultiplier × spread. */
  sdMultiplier: number;
  /** "strict": kept when lower < value < upper. "inclusive": kept when lower <= value <= upper. */
  bounds: BoundsMode;
  /** "pooled": one average and spread over all rounds. "perRound": one per round. */
  scope: LoppingScope;
  /** "one": check once. "iterative": re-check the kept scores until nothing more is set aside. */
  passes: PassMode;
  /** Which standard deviation builds the range. */
  sd: SpreadKind;
  /** Fewer than two scores, so the spread is undefined (the workbook shows #DIV/0!). */
  whenUndefined: EdgeRule;
  /** Every score identical, so the spread is zero and a strict range keeps nothing. */
  zeroSpread: EdgeRule;
  /**
   * Round each edge of the kept range to 15 significant digits before comparing.
   * Excel builds the criteria as text ("<" & number) and a number becomes text
   * with at most 15 significant digits, so this is what the workbook compares.
   */
  excelCriteriaRounding: boolean;
}

/** Upper limit on passes when `passes` is "iterative", so the loop always ends. */
export const MAX_ITERATIVE_PASSES = 10;

/** The director's workbook, knob for knob. This is the default policy. */
export const WORKBOOK_POLICY: Readonly<LoppingPolicy> = Object.freeze({
  sdMultiplier: 2,
  bounds: "strict",
  scope: "pooled",
  passes: "one",
  sd: "sample",
  whenUndefined: "unresolved",
  zeroSpread: "unresolved",
  excelCriteriaRounding: true,
});

/**
 * The workbook policy, but a debater with fewer than two scores or with every
 * score the same keeps all of them instead of waiting for the organiser.
 * Recommended for rooms with a single judge.
 */
export const WORKBOOK_SAFE_POLICY: Readonly<LoppingPolicy> = Object.freeze({
  ...WORKBOOK_POLICY,
  whenUndefined: "keepAll",
  zeroSpread: "keepAll",
});

/** Every policy field, in a fixed order, for comparison and for hashing. */
export const POLICY_KEYS: readonly (keyof LoppingPolicy)[] = [
  "sdMultiplier",
  "bounds",
  "scope",
  "passes",
  "sd",
  "whenUndefined",
  "zeroSpread",
  "excelCriteriaRounding",
];

/** True when both policies would score every division identically. */
export function policyEquals(a: LoppingPolicy, b: LoppingPolicy): boolean {
  return POLICY_KEYS.every((key) => a[key] === b[key]);
}

/**
 * A stable text form of a policy, with the keys in a fixed order, so that the
 * server can hash it and stamp results and exports with the hash.
 */
export function canonicalPolicyJson(policy: LoppingPolicy): string {
  const ordered: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) ordered[key] = policy[key];
  return JSON.stringify(ordered);
}
