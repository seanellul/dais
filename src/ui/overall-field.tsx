"use client";

import type { ReactNode } from "react";

import type { RubricBand } from "@/domain/types";
import { BandBar, findBand } from "@/ui/band-bar";
import { cn } from "@/ui/cn";
import { NumberField } from "@/ui/number-field";

export interface OverallFieldProps {
  value: number | null;
  onValueChange: (value: number | null) => void;
  bands: readonly RubricBand[];
  /** The rubric's overall maximum, 103 at Conyers. */
  max: number;
  id?: string;
  name?: string;
  /** Defaults to "Overall score (out of {max})". */
  label?: ReactNode;
  /** Replaces the field's own range message. */
  error?: ReactNode;
  /** A quiet reminder under the band, e.g. "Scores above 90 are very rare." */
  note?: ReactNode;
  /** Extra ids for aria-describedby. */
  describedBy?: string;
  className?: string;
}

/**
 * The number that counts: a large numeral input, the five-segment band bar,
 * and the band's name and one-line description. The description is a polite
 * live region so a judge hears the band change as they type. NumberField
 * checks the 0 to max range; the band bar goes blank outside it.
 */
export function OverallField({
  value,
  onValueChange,
  bands,
  max,
  id,
  name,
  label,
  error,
  note,
  describedBy,
  className,
}: OverallFieldProps) {
  const match = findBand(bands, value);
  const outOfRange = value !== null && (value < 0 || value > max);

  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4", className)}>
      <NumberField
        id={id}
        name={name}
        size="xl"
        label={label ?? `Overall score (out of ${max})`}
        value={value}
        onValueChange={onValueChange}
        min={0}
        max={max}
        error={error}
        describedBy={describedBy}
        inputClassName="max-w-[5ch]"
        trailing={
          match ? <span className="text-body font-medium text-text">{match.band.label}</span> : null
        }
      />
      <BandBar bands={bands} value={outOfRange ? null : value} className="mt-3" />
      <p aria-live="polite" className="mt-2 min-h-5 text-body-sm text-text-secondary">
        {match ? (
          <>
            <strong className="font-medium text-text">{match.band.label}.</strong>{" "}
            {match.band.summary}
          </>
        ) : (
          "Type a score to see its band."
        )}
      </p>
      {note ? <p className="mt-1 text-caption text-text-muted">{note}</p> : null}
    </div>
  );
}
