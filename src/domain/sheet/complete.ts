/**
 * How far along a sheet is: which debaters are fully scored and which
 * comment boxes are still empty.
 *
 * The names carry a "Sheet" prefix so they never clash with the scoring
 * module's division-level `Completeness`.
 */
import {
  COMMENT_FIELDS,
  hasNumber,
  SCORE_FIELDS,
  type CommentField,
  type ScoreField,
  type SheetDraft,
} from "@/domain/sheet/draft";

export interface SheetMissingField {
  speakerId: string;
  field: ScoreField;
}

export interface SheetCompleteness {
  /** Debaters with all five numbers filled in. */
  scored: number;
  /** Debaters expected on the sheet. */
  total: number;
  missingFields: SheetMissingField[];
}

export function completeness(sheet: SheetDraft, speakerIds: string[]): SheetCompleteness {
  const missingFields: SheetMissingField[] = [];
  let scored = 0;
  for (const speakerId of speakerIds) {
    const score = sheet.scores[speakerId];
    const missing = SCORE_FIELDS.filter((field) => !hasNumber(score, field));
    if (missing.length === 0) scored += 1;
    for (const field of missing) missingFields.push({ speakerId, field });
  }
  return { scored, total: speakerIds.length, missingFields };
}

export interface FeedbackGap {
  speakerId: string;
  field: CommentField;
}

/** Comment boxes that are empty or only whitespace, per debater. */
export function feedbackGaps(sheet: SheetDraft, speakerIds: string[]): FeedbackGap[] {
  const gaps: FeedbackGap[] = [];
  for (const speakerId of speakerIds) {
    const score = sheet.scores[speakerId];
    for (const field of COMMENT_FIELDS) {
      const text = score?.[field];
      if (typeof text !== "string" || text.trim().length === 0) gaps.push({ speakerId, field });
    }
  }
  return gaps;
}
