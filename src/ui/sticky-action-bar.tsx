import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/ui/cn";

export interface StickyActionBarProps extends ComponentProps<"div"> {
  /** Quiet text on the left, e.g. "Saved" or "2 of 4 scored". */
  status?: ReactNode;
}

/**
 * The judge sheet's bottom bar. It sticks to the bottom of the scroll area and
 * pads itself above the iPhone home indicator. globals.css sets
 * scroll-padding-bottom so a focused field is never hidden under it.
 */
export function StickyActionBar({ status, className, children, ...props }: StickyActionBarProps) {
  return (
    <div
      className={cn(
        "sticky-action-bar sticky bottom-0 z-(--z-sticky) mt-auto border-t border-border bg-surface/95 px-4 pt-3 pb-[max(var(--space-3),env(safe-area-inset-bottom))] backdrop-blur",
        className,
      )}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-(--width-judge) items-center gap-3">
        {status ? (
          <div className="min-w-0 flex-1 text-body-sm text-text-secondary">{status}</div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
