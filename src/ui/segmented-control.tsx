"use client";

import type { ReactNode } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";

import { cn } from "@/ui/cn";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Tooltip and screen-reader detail, e.g. "No points of information taken". */
  description?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V | null;
  onValueChange: (value: V) => void;
  /** Accessible name when there is no visible label element. */
  label: string;
  /** Id of a visible label element; overrides `label` for the accessible name. */
  labelledBy?: string;
  name?: string;
  disabled?: boolean;
  /** md = 48px tall (judge POI control), sm = 44px (organiser toolbars). */
  size?: "sm" | "md";
  className?: string;
}

/**
 * A row of mutually exclusive choices, built as a real radio group: arrow keys
 * move between options, Space selects, and the group has one accessible name.
 */
export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  label,
  labelledBy,
  name,
  disabled,
  size = "md",
  className,
}: SegmentedControlProps<V>) {
  return (
    <RadioGroup
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      name={name}
      disabled={disabled}
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      className={cn(
        "grid auto-cols-fr grid-flow-col gap-1 rounded-md border border-border-strong bg-surface-sunken p-1",
        className,
      )}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.description}
          aria-description={option.description}
          className={cn(
            "flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 text-body font-medium text-text-secondary transition-colors duration-(--dur-fast) hover:text-text data-checked:bg-primary data-checked:text-on-primary data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
            size === "md" ? "h-12 min-w-12" : "h-11 min-w-11 text-body-sm",
          )}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
