import type { ComponentProps } from "react";

import type { Side } from "@/domain/types";
import { cn } from "@/ui/cn";

export const SIDE_LABELS: Record<Side, { short: string; full: string }> = {
  government: { short: "Gov", full: "Government" },
  opposition: { short: "Opp", full: "Opposition" },
};

export interface SideTagProps extends ComponentProps<"span"> {
  side: Side;
  /** Show the full word instead of "Gov" / "Opp". */
  full?: boolean;
}

/**
 * Names a team's side. The full word is always available to screen readers,
 * and the hue is never the only signal. Styles: `.side-tag[data-side]`.
 */
export function SideTag({ side, full = false, className, ...props }: SideTagProps) {
  const label = SIDE_LABELS[side];
  return (
    <span
      className={cn("side-tag", className)}
      data-side={side}
      title={full ? undefined : label.full}
      {...props}
    >
      {full ? (
        label.full
      ) : (
        <>
          <span aria-hidden="true">{label.short}</span>
          <span className="sr-only">{label.full}</span>
        </>
      )}
    </span>
  );
}
