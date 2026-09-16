/**
 * The scoring engine. Pure TypeScript: no I/O, no dates, no framework or
 * database types. It runs in the browser, on the server and in tests.
 *
 * Start with `computeDivisionResults` (the only function the app layer calls)
 * and `WORKBOOK_POLICY` (the default policy, knob for knob the director's
 * workbook). `docs/SCORING.md` explains the policy and the workbook mapping.
 */

export {
  MAX_ITERATIVE_PASSES,
  POLICY_KEYS,
  WORKBOOK_POLICY,
  WORKBOOK_SAFE_POLICY,
  canonicalPolicyJson,
  policyEquals,
  type BoundsMode,
  type EdgeRule,
  type LoppingPolicy,
  type LoppingScope,
  type PassMode,
  type SpreadKind,
} from "./policy";

export {
  average,
  computeStats,
  edgeCaseOf,
  excelRounded,
  lopValues,
  spread,
  type Boundary,
  type LopEdgeCase,
  type LopResult,
  type LopStats,
  type LopValue,
  type LoppedValue,
} from "./lop";

export { findTies, rankEq, tiedWith, type RankGroup } from "./rank";

export {
  describeExclusion,
  describePolicy,
  describePooledEdgeCase,
  describeRoundReason,
  type RoundReasonCode,
} from "./describe";

export {
  isKept,
  scoreDebater,
  type DebaterContext,
  type DebaterInput,
  type DebaterResult,
  type DebaterStats,
  type DebaterStatus,
  type Override,
  type OverrideKind,
  type RoundReason,
  type RoundResult,
  type RoundStatus,
  type ScoreOrigin,
  type ScoreSource,
  type SourceOutcome,
  type SourceStatus,
  type StatsTrace,
} from "./debater";

export {
  computeDivisionResults,
  selectTop,
  type Completeness,
  type DivisionInput,
  type DivisionResults,
  type ExpectedSheet,
  type MissingSheet,
  type Ranking,
  type TeamInput,
  type TeamResult,
  type TeamStatus,
  type Tie,
  type TopSelection,
  type UnrankedEntry,
} from "./division";
