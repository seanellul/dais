import type { ComponentProps, ReactNode } from "react";
import { Check } from "lucide-react";

import { cn } from "@/ui/cn";
import { StatusChip, type StatusChipVariant } from "@/ui/status-chip";

export type StepStatus = "done" | "current" | "todo" | "attention" | "skipped";

const STATUS: Record<StepStatus, { variant: StatusChipVariant; label: string }> = {
  done: { variant: "success", label: "Done" },
  current: { variant: "info", label: "Next" },
  todo: { variant: "neutral", label: "Not yet" },
  attention: { variant: "warning", label: "Needs attention" },
  skipped: { variant: "muted-struck", label: "Marked done" },
};

export interface StepRowProps extends Omit<ComponentProps<"li">, "title"> {
  number: number;
  status: StepStatus;
  title: ReactNode;
  /** One plain sentence: "12 Open teams, 8 Novice teams." */
  summary?: ReactNode;
  /** Replaces the default status text, e.g. "3 sheets missing". */
  statusLabel?: string;
  /** The one primary action for this step. */
  action?: ReactNode;
  /** Overflow menu trigger for rarer actions ("Mark done anyway"). */
  overflow?: ReactNode;
}

/**
 * One line of the dashboard run sheet. Render inside an <ol>. The current step
 * carries aria-current="step" and a soft highlight. Rows are at least --row-h
 * tall, so presentation mode spaces them out.
 */
export function StepRow({
  number,
  status,
  title,
  summary,
  statusLabel,
  action,
  overflow,
  className,
  ...props
}: StepRowProps) {
  const { variant, label } = STATUS[status];
  const isCurrent = status === "current";
  return (
    <li
      data-status={status}
      aria-current={isCurrent ? "step" : undefined}
      className={cn(
        "step-row grid min-h-(--row-h) grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 border-b border-divider px-3 py-4 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        isCurrent && "rounded-md bg-highlight-soft",
        className,
      )}
      {...props}
    >
      <StepNumber number={number} status={status} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-text">
            <span className="sr-only">Step {number}: </span>
            {title}
          </span>
          <StatusChip variant={variant}>{statusLabel ?? label}</StatusChip>
        </div>
        {summary ? <p className="mt-1 text-body-sm text-text-secondary">{summary}</p> : null}
      </div>
      {action || overflow ? (
        <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:justify-self-end">
          {action}
          {overflow}
        </div>
      ) : null}
    </li>
  );
}

function StepNumber({ number, status }: { number: number; status: StepStatus }) {
  const done = status === "done" || status === "skipped";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-pill border text-body-sm font-semibold tabular",
        done && "border-primary bg-primary text-on-primary",
        status === "current" && "border-primary bg-primary-surface text-primary",
        status === "attention" && "border-warning bg-warning-surface text-warning",
        status === "todo" && "border-border-strong text-text-muted",
      )}
    >
      {done ? <Check className="size-4" /> : number}
    </span>
  );
}
