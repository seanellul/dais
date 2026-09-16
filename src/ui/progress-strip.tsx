import { cn } from "@/ui/cn";

export interface ProgressStripProps {
  value: number;
  max: number;
  /** Plain words, e.g. "2 of 4 scored". Used as the accessible name. */
  label: string;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  className?: string;
}

export interface Progress {
  /** `value` held inside 0 and `max`. */
  value: number;
  /** `max`, or 0 when a negative maximum was given. */
  max: number;
  /** Whole-number percentage, 0 when there is nothing to count. */
  percent: number;
}

/** Keeps a progress pair sane: no negatives, never past the maximum, no division by zero. */
export function clampProgress(value: number, max: number): Progress {
  const safeMax = Math.max(max, 0);
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = safeMax === 0 ? 0 : Math.round((clamped / safeMax) * 100);
  return { value: clamped, max: safeMax, percent };
}

/** A thin bar with a text label. The text carries the meaning; the bar repeats it. */
export function ProgressStrip({
  value,
  max,
  label,
  hideLabel = false,
  className,
}: ProgressStripProps) {
  const progress = clampProgress(value, max);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className={cn("text-body-sm text-text-secondary tabular", hideLabel && "sr-only")}>
        {label}
      </span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={progress.max}
        aria-valuenow={progress.value}
        className="h-2 w-full overflow-hidden rounded-pill border border-border bg-surface-sunken"
      >
        <div
          className="h-full rounded-pill bg-primary transition-[width] duration-(--dur-slow) ease-standard"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
