/**
 * Band lookups for the Overall score and for the per-category scores.
 *
 * The Guide to Judging prints bands for the Overall score out of 103. For a
 * category out of 33 the guide divides the same floors by three, because the
 * three speech categories together make 99 of the 103 points (the last four
 * are points of information). We generalise that: a band floor scales by
 * `categoryMax / speechPoints` and rounds to the nearest whole number.
 *
 * In a small category two floors can round to the same number. The higher
 * band keeps the floor and the lower band is left out, so every band that
 * remains keeps its true scaled floor and no band is squashed into a range
 * it does not deserve.
 */
import type { RubricBand } from "@/domain/types";

/** The points shared by the three speech categories in the default rubric. */
export const DEFAULT_SPEECH_POINTS = 99;

/** The band whose inclusive range holds `value`, or null when none does. */
export function bandFor(value: number, bands: RubricBand[]): RubricBand | null {
  if (!Number.isFinite(value)) return null;
  return bands.find((band) => value >= band.min && value <= band.max) ?? null;
}

/**
 * The bands scaled to one category. Floors are scaled and rounded; each
 * band then runs up to the floor of the band above, and the top band runs
 * to `categoryMax`. A band whose scaled floor sits above the room left for
 * it is left out. Every band returned has `0 <= min <= max`.
 */
export function categoryBands(
  categoryMax: number,
  bands: RubricBand[],
  speechPoints = DEFAULT_SPEECH_POINTS,
): RubricBand[] {
  const byFloorDescending = [...bands].sort((a, b) => b.min - a.min);
  let ceiling = categoryMax;
  const scaled: RubricBand[] = [];
  for (const band of byFloorDescending) {
    if (ceiling < 0) break;
    const min = Math.max(0, scaleFloor(band.min, categoryMax, speechPoints));
    if (min > ceiling) continue;
    scaled.push({ ...band, min, max: ceiling });
    ceiling = min - 1;
  }
  return scaled;
}

/** The scaled band that holds a category score, or null when out of range. */
export function categoryBandFor(
  value: number,
  categoryMax: number,
  bands: RubricBand[],
  speechPoints = DEFAULT_SPEECH_POINTS,
): RubricBand | null {
  return bandFor(value, categoryBands(categoryMax, bands, speechPoints));
}

function scaleFloor(floor: number, categoryMax: number, speechPoints: number): number {
  return Math.round((floor * categoryMax) / speechPoints);
}
