import type { ComponentProps } from "react";

import { DEFAULT_ROLE_LABELS, type RoleKey, type RoleLabels } from "@/domain/types";
import { cn } from "@/ui/cn";

export interface RoleTagProps extends ComponentProps<"span"> {
  /** Speaking role. Named roleKey so it does not clash with the ARIA `role` attribute. */
  roleKey: RoleKey;
  /** Tournament-specific labels; defaults to the parliamentary names. */
  labels?: RoleLabels;
}

/**
 * Names a speaking role: "PM", "LO", "GM", "OM". The full label is the
 * tooltip and the screen-reader text. Styles: `.role-tag`.
 */
export function RoleTag({
  roleKey,
  labels = DEFAULT_ROLE_LABELS,
  className,
  ...props
}: RoleTagProps) {
  const full = labels[roleKey];
  return (
    <span className={cn("role-tag", className)} title={full} {...props}>
      <span aria-hidden="true">{roleKey.toUpperCase()}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}
