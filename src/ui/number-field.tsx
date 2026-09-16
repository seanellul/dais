"use client";

import { useId, useState, type ReactNode } from "react";
import { CircleMinus } from "lucide-react";

import { cn } from "@/ui/cn";

export type NumberFieldSize = "md" | "lg" | "xl";

export interface NumberFieldProps {
  id?: string;
  name?: string;
  /** Accessible and visible label, e.g. "Argumentation". */
  label: ReactNode;
  /** Short help under the label, e.g. "out of 33". */
  hint?: ReactNode;
  /**
   * Validation message from the caller. It replaces the field's own range
   * message, sets aria-invalid and is linked with aria-describedby.
   */
  error?: ReactNode;
  value: number | null;
  onValueChange: (value: number | null) => void;
  /** Lowest allowed value. A value below it shows a range error. */
  min?: number;
  /** Highest allowed value. A value above it shows a range error. */
  max?: number;
  /** Allow a decimal point. Default is whole numbers only. */
  allowDecimals?: boolean;
  /** Right-side slot, e.g. a band micro-label. */
  trailing?: ReactNode;
  /** md = 48px input, lg = 56px with a large numeral, xl = the Overall numeral. */
  size?: NumberFieldSize;
  disabled?: boolean;
  required?: boolean;
  /** Extra ids for aria-describedby, space separated. */
  describedBy?: string;
  className?: string;
  inputClassName?: string;
  onBlur?: () => void;
}

const SIZE_CLASSES: Record<NumberFieldSize, string> = {
  md: "h-12 px-3 text-base",
  lg: "h-14 px-3 numeral text-numeral",
  xl: "h-20 px-3 numeral text-numeral-xl",
};

/** Keeps only the characters a score can contain: digits, and one decimal point when allowed. */
export function cleanDigits(raw: string, allowDecimals: boolean): string {
  const digits = raw.replace(allowDecimals ? /[^\d.]/g : /\D/g, "");
  if (!allowDecimals) return digits;
  const [whole, ...rest] = digits.split(".");
  return rest.length === 0 ? whole : `${whole}.${rest.join("")}`;
}

/** Turns cleaned text into a number, or null when empty or incomplete. */
export function parseNumber(text: string): number | null {
  if (text === "" || text === ".") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The message for a value outside [min, max], or null when the value is in
 * range, empty, or no limit is set. Written the way the judge sheet says it:
 * "Enter a whole number from 0 to 33."
 */
export function rangeError(
  value: number | null,
  min?: number,
  max?: number,
  allowDecimals = false,
): string | null {
  if (value === null) return null;
  const noun = allowDecimals ? "a number" : "a whole number";
  const belowMin = min !== undefined && value < min;
  const aboveMax = max !== undefined && value > max;
  if (!belowMin && !aboveMax) return null;
  if (min !== undefined && max !== undefined) return `Enter ${noun} from ${min} to ${max}.`;
  if (min !== undefined) return `Enter ${noun} of at least ${min}.`;
  return `Enter ${noun} of at most ${max}.`;
}

function formatValue(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * A score input for phones: numeric keypad, 16px+ text so iOS does not zoom,
 * 48px tall, label and hint and error wired with ARIA. The value is a number or
 * null; the field keeps its own text so a half-typed "12." is not lost.
 *
 * `min` and `max` are checked here, not by the browser: the input is
 * type="text" (for the numeric keypad), where the browser ignores them.
 */
export function NumberField({
  id: idProp,
  name,
  label,
  hint,
  error: errorProp,
  value,
  onValueChange,
  min,
  max,
  allowDecimals = false,
  trailing,
  size = "md",
  disabled,
  required,
  describedBy,
  className,
  inputClassName,
  onBlur,
}: NumberFieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [text, setText] = useState(() => formatValue(value));
  const [syncedValue, setSyncedValue] = useState(value);

  // Follow external changes (autosave restore, reset) without clobbering typing.
  // This is React's "adjust state while rendering" pattern, not an effect.
  if (value !== syncedValue) {
    setSyncedValue(value);
    if (parseNumber(text) !== value) setText(formatValue(value));
  }

  const error = errorProp ?? rangeError(value, min, max, allowDecimals);
  const describedIds = [hint ? hintId : null, error ? errorId : null, describedBy ?? null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-body-sm font-medium text-text">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-caption text-text-secondary">
          {hint}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <input
          id={id}
          name={name}
          type="text"
          inputMode={allowDecimals ? "decimal" : "numeric"}
          pattern={allowDecimals ? "[0-9]*[.]?[0-9]*" : "[0-9]*"}
          autoComplete="off"
          enterKeyHint="next"
          value={text}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedIds || undefined}
          onChange={(event) => {
            const next = cleanDigits(event.target.value, allowDecimals);
            setText(next);
            onValueChange(parseNumber(next));
          }}
          onBlur={() => {
            setText(formatValue(value));
            onBlur?.();
          }}
          className={cn(
            "w-full min-w-0 rounded-md border border-border-strong bg-surface text-text tabular placeholder:text-text-muted disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60 aria-invalid:border-danger",
            SIZE_CLASSES[size],
            inputClassName,
          )}
        />
        {trailing ? (
          <div className="shrink-0 text-body-sm text-text-secondary">{trailing}</div>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-body-sm text-danger">
          <CircleMinus aria-hidden="true" className="size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
