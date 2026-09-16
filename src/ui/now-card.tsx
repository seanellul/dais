import { useId, type ReactNode } from "react";

import { cn } from "@/ui/cn";
import { ProgressStrip } from "@/ui/progress-strip";

export interface NowCardProps {
  /** Short eyebrow, e.g. "Sheets in, Round 1". */
  label: string;
  value: number;
  /** When given, a progress strip and "of {max}" appear. */
  max?: number;
  /** One sentence under the numeral, e.g. "Room 4 still scoring." */
  detail?: ReactNode;
  /** Accessible name for the progress strip. Defaults to "{value} of {max}". */
  progressLabel?: string;
  /** Heading level for the label; defaults to h2. */
  heading?: "h2" | "h3";
  className?: string;
}

/**
 * The dashboard's "Now" card: a numeral readable from three metres, plus a
 * progress strip. Numbers use tabular figures so they do not jump as they tick.
 */
export function NowCard({
  label,
  value,
  max,
  detail,
  progressLabel,
  heading: Heading = "h2",
  className,
}: NowCardProps) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("rounded-lg border border-border bg-surface p-5 elevation-1", className)}
    >
      <Heading id={id} className="text-eyebrow font-sans">
        {label}
      </Heading>
      <p className="mt-2 flex items-baseline gap-2">
        <span className="numeral text-numeral-xl text-text">{value}</span>
        {max !== undefined ? (
          <span className="numeral text-numeral text-text-muted">of {max}</span>
        ) : null}
      </p>
      {detail ? <p className="mt-1 text-body-sm text-text-secondary">{detail}</p> : null}
      {max !== undefined ? (
        <ProgressStrip
          className="mt-4"
          value={value}
          max={max}
          label={progressLabel ?? `${value} of ${max}`}
          hideLabel
        />
      ) : null}
    </section>
  );
}
