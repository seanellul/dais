/**
 * The points-of-information scale from the Guide to Judging. It uses the
 * same shape as the Overall bands so `bandFor` works on it.
 */
import type { RubricBand } from "@/domain/types";
import { bandFor } from "@/domain/rubric/bands";

export const POI_BANDS: RubricBand[] = [
  { min: 4, max: 4, label: "Excellent", summary: "Fearless and responsive" },
  { min: 2, max: 3, label: "Good", summary: "A good attempt" },
  { min: 1, max: 1, label: "Fair", summary: "An attempt" },
  { min: 0, max: 0, label: "Poor", summary: "Did not ask or answer" },
];

/** The label and summary for one points-of-information score. */
export function poiBandFor(value: number): RubricBand | null {
  return bandFor(value, POI_BANDS);
}
