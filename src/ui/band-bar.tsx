import type { RubricBand } from "@/domain/types";
import { cn } from "@/ui/cn";

export interface BandMatch {
  band: RubricBand;
  /** Position in the ascending band list, 0 = lowest. */
  index: number;
}

/** Sorts bands from lowest to highest score. */
export function sortBands(bands: readonly RubricBand[]): RubricBand[] {
  return [...bands].sort((a, b) => a.min - b.min);
}

/** Finds the band that contains `value`, or null when there is no value or no match. */
export function findBand(bands: readonly RubricBand[], value: number | null): BandMatch | null {
  if (value === null || Number.isNaN(value)) return null;
  const ordered = sortBands(bands);
  const index = ordered.findIndex((band) => value >= band.min && value <= band.max);
  return index === -1 ? null : { band: ordered[index], index };
}

export interface BandBarProps {
  bands: readonly RubricBand[];
  value: number | null;
  className?: string;
}

/**
 * Five segments in one hue, filled up to the band the score falls in. It is a
 * picture of the band label next to it, so it reads as an image with a name.
 * Styles: `.band-bar`, `.band-bar__segment[data-filled]`.
 */
export function BandBar({ bands, value, className }: BandBarProps) {
  const ordered = sortBands(bands);
  const match = findBand(ordered, value);
  const name = match
    ? `Band ${match.index + 1} of ${ordered.length}: ${match.band.label}`
    : "No band yet";

  return (
    <div role="img" aria-label={name} className={cn("band-bar", className)}>
      {ordered.map((band, index) => (
        <span
          key={`${band.min}-${band.max}`}
          className="band-bar__segment"
          data-filled={match !== null && index <= match.index ? "true" : "false"}
        />
      ))}
    </div>
  );
}
