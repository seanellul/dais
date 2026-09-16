/**
 * A sheet while the judge is still filling it in. Every field may be
 * absent. A finished `SheetPayload` satisfies this shape too, so the
 * totals and completeness helpers accept both.
 */
import type { SpeakerScore } from "@/domain/types";

export type DraftSpeakerScore = Partial<SpeakerScore>;

export interface SheetDraft {
  scores: Record<string, DraftSpeakerScore | undefined>;
}

/** The five numeric fields on a sheet, in display order. */
export const SCORE_FIELDS = [
  "argumentation",
  "rebuttal",
  "presentation",
  "poi",
  "overall",
] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];

/** The two comment fields. */
export const COMMENT_FIELDS = ["www", "ebi"] as const;
export type CommentField = (typeof COMMENT_FIELDS)[number];

/** True when a draft field holds a real number. */
export function hasNumber(score: DraftSpeakerScore | undefined, field: ScoreField): boolean {
  const value = score?.[field];
  return typeof value === "number" && Number.isFinite(value);
}
