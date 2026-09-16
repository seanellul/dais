/**
 * Setting scores aside ("lopping"), generalised from the prototype's
 * `scoreStudent` with an explicit policy.
 *
 * `lopValues` takes a list of scores, each tagged with a source id, and
 * returns which sources are kept and which are set aside, together with the
 * average, spread and kept range that decided it. Attribution flows through
 * the id: the caller never has to guess which judge a set-aside value came
 * from.
 */

import { MAX_ITERATIVE_PASSES, type LoppingPolicy, type SpreadKind } from "./policy";

/** One score with the id of the sheet it came from. */
export interface LopValue {
  value: number;
  sourceId: string;
}

/** Average, spread and kept range for one set of scores. `null` when undefined. */
export interface LopStats {
  n: number;
  mean: number | null;
  sd: number | null;
  lower: number | null;
  upper: number | null;
}

export type Boundary = "lower" | "upper";

export interface LoppedValue {
  sourceId: string;
  /** Which pass set the value aside (always 1 under a one-pass policy). */
  pass: number;
  /** Set when the value sits exactly on an edge of the kept range. */
  onBoundary?: Boundary;
}

/** Why the kept range could not be built from the scores. */
export type LopEdgeCase = "sd_undefined" | "zero_spread";

export interface LopResult {
  /** Statistics of the first pass: what the workbook's Average and SD columns show. */
  stats: LopStats;
  /** Statistics of every pass that ran, first pass first. One entry under a one-pass policy. */
  passStats: LopStats[];
  retained: string[];
  lopped: LoppedValue[];
  /** Set when the scores had no usable spread, whatever the policy did about it. */
  edgeCase?: LopEdgeCase;
  /** Set only when the edge case left nothing kept, so the caller cannot average. */
  reason?: LopEdgeCase;
}

/** Plain average in input order (so it sums exactly as a spreadsheet would). */
export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Standard deviation: STDEV.S divides by n − 1, STDEV.P by n. `null` when undefined. */
export function spread(values: number[], kind: SpreadKind): number | null {
  const divisor = kind === "sample" ? values.length - 1 : values.length;
  const mean = average(values);
  if (mean === null || divisor < 1) return null;
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  return Math.sqrt(squares / divisor);
}

/**
 * A number as Excel would write it into text: at most 15 significant digits.
 * `"<" & 83.4000000000000056` becomes `"<83.4"`, and AVERAGEIFS compares
 * against 83.4.
 */
export function excelRounded(value: number): number {
  return Number(value.toPrecision(15));
}

/** Average, spread and kept range for a set of scores under a policy. */
export function computeStats(values: number[], policy: LoppingPolicy): LopStats {
  const mean = average(values);
  const sd = spread(values, policy.sd);
  if (mean === null || sd === null) {
    return { n: values.length, mean, sd, lower: null, upper: null };
  }
  const halfWidth = policy.sdMultiplier * sd;
  return { n: values.length, mean, sd, lower: mean - halfWidth, upper: mean + halfWidth };
}

/** Whether these statistics leave the kept range undefined or empty. */
export function edgeCaseOf(stats: LopStats): LopEdgeCase | undefined {
  if (stats.n < 2 || stats.sd === null) return "sd_undefined";
  if (stats.sd === 0) return "zero_spread";
  return undefined;
}

/** The edges of the kept range as the comparison will see them. */
function comparisonEdges(stats: LopStats, policy: LoppingPolicy): { lower: number; upper: number } {
  const lower = stats.lower ?? Number.NaN;
  const upper = stats.upper ?? Number.NaN;
  return policy.excelCriteriaRounding
    ? { lower: excelRounded(lower), upper: excelRounded(upper) }
    : { lower, upper };
}

function isInside(value: number, lower: number, upper: number, policy: LoppingPolicy): boolean {
  return policy.bounds === "strict"
    ? value > lower && value < upper
    : value >= lower && value <= upper;
}

function boundaryOf(value: number, lower: number, upper: number): Boundary | undefined {
  if (value === lower) return "lower";
  if (value === upper) return "upper";
  return undefined;
}

function markLopped(value: LopValue, pass: number, onBoundary?: Boundary): LoppedValue {
  return onBoundary
    ? { sourceId: value.sourceId, pass, onBoundary }
    : { sourceId: value.sourceId, pass };
}

/** Split one pass's values into kept and set aside. */
function partition(
  values: LopValue[],
  stats: LopStats,
  policy: LoppingPolicy,
  pass: number,
): { kept: LopValue[]; lopped: LoppedValue[] } {
  const { lower, upper } = comparisonEdges(stats, policy);
  const kept: LopValue[] = [];
  const lopped: LoppedValue[] = [];
  for (const item of values) {
    if (isInside(item.value, lower, upper, policy)) kept.push(item);
    else lopped.push(markLopped(item, pass, boundaryOf(item.value, lower, upper)));
  }
  return { kept, lopped };
}

/** The result when the first pass has no usable spread. */
function resolveEdgeCase(
  values: LopValue[],
  stats: LopStats,
  edgeCase: LopEdgeCase,
  policy: LoppingPolicy,
): LopResult {
  const rule = edgeCase === "sd_undefined" ? policy.whenUndefined : policy.zeroSpread;
  if (rule === "keepAll") {
    return {
      stats,
      passStats: [stats],
      retained: values.map((v) => v.sourceId),
      lopped: [],
      edgeCase,
    };
  }
  // The workbook's strict AVERAGEIFS keeps nothing here: every value sits on
  // the (collapsed) edge of the range or the range does not exist at all.
  const { lower, upper } = comparisonEdges(stats, policy);
  const lopped = values.map((item) => markLopped(item, 1, boundaryOf(item.value, lower, upper)));
  return { stats, passStats: [stats], retained: [], lopped, edgeCase, reason: edgeCase };
}

/**
 * Decide which scores are kept under a policy.
 *
 * Non-finite values are ignored, as a blank cell is in a spreadsheet. Under
 * "iterative" passes the range is rebuilt from the kept scores and applied
 * again until a pass sets nothing aside, the kept scores lose their spread,
 * or `MAX_ITERATIVE_PASSES` is reached. Each set-aside value records the pass
 * that removed it.
 */
export function lopValues(input: LopValue[], policy: LoppingPolicy): LopResult {
  const values = input.filter((item) => Number.isFinite(item.value));
  const first = computeStats(
    values.map((item) => item.value),
    policy,
  );
  const edgeCase = edgeCaseOf(first);
  if (edgeCase) return resolveEdgeCase(values, first, edgeCase, policy);

  const passStats: LopStats[] = [first];
  const lopped: LoppedValue[] = [];
  let kept = values;
  let stats = first;
  for (let pass = 1; pass <= MAX_ITERATIVE_PASSES; pass += 1) {
    const result = partition(kept, stats, policy, pass);
    kept = result.kept;
    lopped.push(...result.lopped);
    const another =
      policy.passes === "iterative" && result.lopped.length > 0 && pass < MAX_ITERATIVE_PASSES;
    if (!another) break;
    stats = computeStats(
      kept.map((item) => item.value),
      policy,
    );
    if (edgeCaseOf(stats)) break; // nothing left to check against
    passStats.push(stats); // the statistics of the pass that runs next
  }
  return { stats: first, passStats, retained: kept.map((item) => item.sourceId), lopped };
}
