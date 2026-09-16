import type { ComponentProps } from "react";

import { cn } from "@/ui/cn";

/** A keyboard key, for the presenter shortcuts help: <Kbd>g</Kbd> <Kbd>d</Kbd>. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface-sunken px-1 font-mono text-caption text-text-secondary",
        className,
      )}
      {...props}
    />
  );
}
