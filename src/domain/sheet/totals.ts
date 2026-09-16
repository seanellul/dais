/**
 * Team totals on one judge's sheet. Only the Overall score counts; the
 * categories are guidance for the judge, never added up for ranking.
 */
import type { AssignmentDisplay, Side, SpeakerScore } from "@/domain/types";
import { hasNumber, type SheetDraft } from "@/domain/sheet/draft";

export interface TeamTotals {
  /** Keyed by the side each team was drawn on, as in `display`. */
  government: number | null;
  opposition: number | null;
}

/**
 * The sum of each team's Overall scores, or null until every debater on
 * that side has one. Sides are the drawn sides from `display`; use
 * `actualSide` from the rubric module when the room swapped them.
 */
export function teamTotals(sheet: SheetDraft, display: AssignmentDisplay): TeamTotals {
  return {
    government: sideTotal(sheet, display, "government"),
    opposition: sideTotal(sheet, display, "opposition"),
  };
}

function sideTotal(sheet: SheetDraft, display: AssignmentDisplay, side: Side): number | null {
  const speakers = display.speakers.filter((speaker) => speaker.side === side);
  if (speakers.length === 0) return null;
  let total = 0;
  for (const speaker of speakers) {
    const score = sheet.scores[speaker.id];
    if (!hasNumber(score, "overall")) return null;
    total += score?.overall ?? 0;
  }
  return total;
}

/**
 * The four categories added up. Shown as a hint only: the Overall score is
 * the judge's own number and stays independent.
 */
export function categorySum(score: Partial<SpeakerScore>): number | null {
  const parts = [score.argumentation, score.rebuttal, score.presentation, score.poi];
  if (parts.some((part) => typeof part !== "number" || !Number.isFinite(part))) return null;
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}
