/**
 * Builders for scoring tests. Every name here is invented.
 */

import {
  WORKBOOK_POLICY,
  isKept,
  scoreDebater,
  type DebaterInput,
  type DebaterResult,
  type DivisionInput,
  type ExpectedSheet,
  type LopEdgeCase,
  type LoppingPolicy,
  type Override,
  type RoundReason,
  type ScoreSource,
  type TeamInput,
} from "@/domain/scoring";

type SourceSeed = Pick<ScoreSource, "round" | "debaterId" | "value"> & Partial<ScoreSource>;

/** One judge score with sensible defaults for the fields a test does not care about. */
export function source(seed: SourceSeed): ScoreSource {
  const judgeId = seed.judgeId ?? `judge-${seed.round}`;
  return {
    assignmentId: seed.assignmentId ?? `asg-r${seed.round}-${judgeId}`,
    judgeId,
    judgeName: seed.judgeName ?? `Judge ${judgeId}`,
    sheetVersion: 1,
    source: "judge",
    ...seed,
  };
}

/** The prototype's `scoreStudent` shape, rebuilt from the new engine. */
export interface LegacyShape {
  mean: number | null;
  sd: number | null;
  lower: number | null;
  upper: number | null;
  rounds: {
    average: number | null;
    retained: number[];
    excluded: number[];
    status: "ready" | "unresolved";
  }[];
  total: number | null;
  status: "ready" | "unresolved";
  /** The pooled edge case if one applied, else the first round reason. */
  reason: LopEdgeCase | RoundReason | null;
  result: DebaterResult;
}

/**
 * Score one debater from a list of rounds, each a list of judge values, the
 * way the prototype's tests were written. Non-numbers are skipped like blank
 * cells; NaN and Infinity are passed through so the engine's own filter is
 * exercised.
 */
export function scoreRounds(
  rounds: (number | null | undefined)[][],
  policy: LoppingPolicy = WORKBOOK_POLICY,
  overrides: Override[] = [],
): LegacyShape {
  const debater: DebaterInput = { id: "d", name: "Debater", teamId: "t", position: 1 };
  const roundNumbers = rounds.map((_, index) => index + 1);
  const sources = rounds.flatMap((values, roundIndex) =>
    values.flatMap((value, slot) =>
      typeof value === "number"
        ? [
            source({
              round: roundIndex + 1,
              debaterId: "d",
              value,
              judgeId: `j${slot + 1}`,
              assignmentId: `asg-r${roundIndex + 1}-j${slot + 1}`,
            }),
          ]
        : [],
    ),
  );
  const result = scoreDebater(debater, roundNumbers, sources, overrides, policy);
  const stats =
    result.stats.scope === "pooled"
      ? result.stats
      : { mean: null, sd: null, lower: null, upper: null };
  const firstUnresolved = result.rounds.find((round) => round.status !== "ready");
  const pooledEdge = result.rounds.find(
    (round) => round.reason === "sd_undefined" || round.reason === "zero_spread",
  );
  return {
    mean: stats.mean,
    sd: stats.sd,
    lower: stats.lower,
    upper: stats.upper,
    rounds: result.rounds.map((round) => ({
      average: round.average,
      retained: round.sources.filter(isKept).map((s) => s.value),
      excluded: round.sources.filter((s) => !isKept(s)).map((s) => s.value),
      status: round.status === "ready" ? "ready" : "unresolved",
    })),
    total: result.total,
    status: result.status,
    reason: pooledEdge?.reason ?? firstUnresolved?.reason ?? null,
    result,
  };
}

export const RED: TeamInput = {
  id: "team-red",
  code: "O01",
  name: "Red",
  school: "Harbourview Academy",
  debaterIds: ["a", "b"],
};

export const BLUE: TeamInput = {
  id: "team-blue",
  code: "O02",
  name: "Blue",
  school: "Northgate School",
  debaterIds: ["c", "d"],
};

export const DEBATERS: DebaterInput[] = [
  { id: "a", name: "Aurelia Ashcombe", teamId: RED.id, position: 1 },
  { id: "b", name: "Bram Brightwater", teamId: RED.id, position: 2 },
  { id: "c", name: "Cassia Calloway", teamId: BLUE.id, position: 1 },
  { id: "d", name: "Dorian Dunmore", teamId: BLUE.id, position: 2 },
];

export interface SheetSpec {
  round: number;
  judgeId?: string;
  judgeName?: string;
  roomName?: string;
  /** `null` means the sheet is expected but has not been received. */
  scores: Record<string, number> | null;
  /** Debaters the sheet covers; defaults to the keys of `scores`. */
  debaterIds?: string[];
  orphaned?: boolean;
}

/** One expected sheet and the scores it carries (none when missing). */
export function sheet(spec: SheetSpec): { expected: ExpectedSheet; scores: ScoreSource[] } {
  const judgeId = spec.judgeId ?? `judge-${spec.round}`;
  const judgeName = spec.judgeName ?? `Judge ${judgeId}`;
  const assignmentId = `asg-r${spec.round}-${judgeId}`;
  const debaterIds = spec.debaterIds ?? Object.keys(spec.scores ?? {});
  const expected: ExpectedSheet = {
    assignmentId,
    round: spec.round,
    judgeId,
    judgeName,
    roomName: spec.roomName ?? "Room 1",
    debaterIds,
    received: spec.scores !== null,
    ...(spec.orphaned ? { orphaned: true } : {}),
  };
  const scores = Object.entries(spec.scores ?? {}).map(([debaterId, value]) =>
    source({ round: spec.round, debaterId, value, judgeId, judgeName, assignmentId }),
  );
  return { expected, scores };
}

/** A division input for the Red/Blue fixture, built from a list of sheets. */
export function division(sheets: SheetSpec[], partial: Partial<DivisionInput> = {}): DivisionInput {
  const built = sheets.map(sheet);
  return {
    divisionId: "open",
    rounds: [1, 2, 3],
    debaters: DEBATERS,
    teams: [RED, BLUE],
    expectedSheets: built.map((b) => b.expected),
    scores: built.flatMap((b) => b.scores),
    overrides: [],
    policy: WORKBOOK_POLICY,
    topN: 2,
    ...partial,
  };
}

/** Sheets for rounds 1..3 from one judge per round, given each debater's values. */
export function roundsFor(values: Record<string, number[]>, rounds = [1, 2, 3]): SheetSpec[] {
  return rounds.map((round, index) => ({
    round,
    scores: Object.fromEntries(
      Object.entries(values).flatMap(([id, list]) =>
        list[index] === undefined ? [] : [[id, list[index]]],
      ),
    ),
    debaterIds: Object.keys(values),
  }));
}
