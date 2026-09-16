import { Check } from "lucide-react";

import { cn } from "@/ui/cn";

export interface StepperProps {
  /** Step names in order, e.g. ["Motion", "Sides", "Roles"]. */
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
  /** Accessible name of the group. */
  label?: string;
  className?: string;
}

/**
 * The judge's "Before you score" progress: numbered dots with names. It is a
 * labelled group, not a <nav>: it holds no links, and print.css hides every
 * <nav>, which would take the step indicator off a printed page.
 */
export function Stepper({ steps, current, label = "Steps", className }: StepperProps) {
  return (
    <div role="group" aria-label={label} className={className}>
      <p className="sr-only">
        Step {current + 1} of {steps.length}
      </p>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "todo";
          return (
            <li
              key={step}
              aria-current={state === "current" ? "step" : undefined}
              className="flex items-center gap-2 text-body-sm"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 items-center justify-center rounded-pill border text-caption font-semibold tabular",
                  state === "done" && "border-primary bg-primary text-on-primary",
                  state === "current" && "border-primary bg-primary-surface text-primary",
                  state === "todo" && "border-border-strong text-text-muted",
                )}
              >
                {state === "done" ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className={state === "current" ? "font-medium text-text" : "text-text-muted"}>
                {step}
              </span>
              {state === "done" ? <span className="sr-only">(done)</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
