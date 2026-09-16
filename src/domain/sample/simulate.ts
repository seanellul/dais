/**
 * Simulate one judge's sheet for a debate, for demos and sandboxes.
 *
 * Each debater has a hidden ability (62 to 92) fixed by their id, each
 * judge a small bias fixed by their id, and every score adds a little
 * noise. A sheet can also carry one "typo" of 18 points, so the results
 * page has a set-aside score to show: either by chance (`rogueChance`) or
 * planted on a named debater (`plantRogue`).
 *
 * A rogue score is set aside only when the debater has enough other
 * scores to compare it with. Under the workbook rule (a kept range of
 * average ± 2 × spread over every round, edges excluded) that takes three
 * judges per room over three rounds: nine scores. With two judges per room
 * (six scores) an 18-point slip is set aside fewer than one time in ten,
 * because one value out of six can hardly ever sit two spreads from the
 * average. `generateSample` therefore defaults to three judges per room.
 */
import type { AssignmentDisplay, Rubric, SheetPayload, SpeakerScore } from "@/domain/types";
import { createRng, hashToUnit, type Rng } from "@/domain/sample/prng";
import { EBI_PHRASES, WWW_PHRASES } from "@/domain/sample/phrases";

/** A rogue score placed on purpose, so a demo can show exactly one per division. */
export interface PlantedRogue {
  /** The debater whose Overall score moves. Nothing happens when they are not on this sheet. */
  speakerId: string;
  /**
   * Signed points to add. Defaults to +18. The move turns the other way
   * when it would leave the rubric's range, for example +18 on a 90.
   */
  delta?: number;
}

export interface SimulateSheetOptions {
  seed: string | number;
  assignmentDisplay: AssignmentDisplay;
  rubric: Rubric;
  /** A stable key for the judge's bias; the judge's name when omitted. */
  judgeId?: string;
  /**
   * Chance that one score on the sheet is off by 18. Default 0.04.
   * Ignored when `plantRogue` is set.
   */
  rogueChance?: number;
  /** Put the rogue score on a named debater instead of leaving it to chance. */
  plantRogue?: PlantedRogue;
  sideFlipped?: boolean;
  roleSwaps?: Record<string, boolean>;
}

export const ABILITY_MIN = 62;
export const ABILITY_MAX = 92;
export const JUDGE_BIAS_MAX = 3;
export const SCORE_NOISE_SD = 3;
export const OVERALL_FLOOR = 40;
export const OVERALL_CEILING = 100;
export const ROGUE_DELTA = 18;

/** Weights for points-of-information scores 0 to 4; most debaters land on 2 or 3. */
const POI_WEIGHTS = [1, 3, 5, 4, 2];

/** A debater's hidden ability, 62 to 92, fixed by their id. */
export function latentAbility(speakerId: string): number {
  return ABILITY_MIN + hashToUnit(`ability|${speakerId}`) * (ABILITY_MAX - ABILITY_MIN);
}

/** A judge's habit of scoring high or low, -3 to +3, fixed by their key. */
export function judgeBias(judgeKey: string): number {
  return -JUDGE_BIAS_MAX + hashToUnit(`bias|${judgeKey}`) * 2 * JUDGE_BIAS_MAX;
}

export function simulateSheet(options: SimulateSheetOptions): SheetPayload {
  const { assignmentDisplay: display, rubric, rogueChance = 0.04 } = options;
  const judgeKey = options.judgeId ?? display.judgeName;
  const speakerIds = display.speakers.map((speaker) => speaker.id);
  const rng = createRng(`sheet|${options.seed}|${judgeKey}|${speakerIds.join(",")}`);
  const bias = judgeBias(judgeKey);

  const scores: Record<string, SpeakerScore> = {};
  for (const id of speakerIds) {
    const overall = clamp(
      Math.round(latentAbility(id) + bias + rng.gaussian(0, SCORE_NOISE_SD)),
      OVERALL_FLOOR,
      OVERALL_CEILING,
    );
    scores[id] = speakerScore(overall, rubric, rng);
  }

  if (options.plantRogue) {
    const { speakerId, delta = ROGUE_DELTA } = options.plantRogue;
    moveOverall(scores, speakerId, delta, rubric);
  } else if (speakerIds.length > 0 && rng.chance(rogueChance)) {
    moveOverall(scores, rng.pick(speakerIds), rng.chance(0.5) ? ROGUE_DELTA : -ROGUE_DELTA, rubric);
  }

  return {
    scores,
    sideFlipped: options.sideFlipped ?? false,
    roleSwaps: options.roleSwaps ?? {},
  };
}

/** Category marks that sit near the Overall, plus two comments. */
function speakerScore(overall: number, rubric: Rubric, rng: Rng): SpeakerScore {
  const share = overall / rubric.overallMax;
  const category = (key: "argumentation" | "rebuttal" | "presentation") => {
    const max = categoryMax(rubric, key);
    return clamp(Math.round(share * max + rng.int(-2, 2)), 0, max);
  };
  return {
    argumentation: category("argumentation"),
    rebuttal: category("rebuttal"),
    presentation: category("presentation"),
    poi: clamp(weightedIndex(POI_WEIGHTS, rng), 0, categoryMax(rubric, "poi")),
    overall,
    www: rng.pick(WWW_PHRASES),
    ebi: rng.pick(EBI_PHRASES),
  };
}

/**
 * Move one debater's Overall by `delta`, like a slip of the pen. The move
 * turns the other way when it would leave the rubric's range, and is
 * clamped as a last resort. A debater who is not on the sheet is left alone.
 */
function moveOverall(
  scores: Record<string, SpeakerScore>,
  speakerId: string,
  delta: number,
  rubric: Rubric,
): void {
  const score = scores[speakerId];
  if (!score) return;
  const inRange = (value: number) => value >= 0 && value <= rubric.overallMax;
  const signed = inRange(score.overall + delta) ? delta : -delta;
  scores[speakerId] = { ...score, overall: clamp(score.overall + signed, 0, rubric.overallMax) };
}

function categoryMax(
  rubric: Rubric,
  key: "argumentation" | "rebuttal" | "presentation" | "poi",
): number {
  return rubric.categories.find((category) => category.key === key)?.max ?? 0;
}

/** Index 0..n-1 chosen with the given relative weights. */
function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
