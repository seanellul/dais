import type { ComponentProps } from "react";

import { cn } from "@/ui/cn";

/** Inline text with tabular figures, so columns of numbers line up. */
export function Tabular({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("tabular", className)} {...props} />;
}
