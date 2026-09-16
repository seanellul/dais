import type { ComponentProps, ReactNode } from "react";
import {
  Ban,
  CircleCheck,
  CircleDot,
  Info,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/ui/cn";

export type StatusChipVariant =
  "neutral" | "success" | "warning" | "danger" | "info" | "muted-struck";

const DEFAULT_ICONS: Record<StatusChipVariant, LucideIcon> = {
  neutral: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonX,
  info: Info,
  "muted-struck": Ban,
};

export interface StatusChipProps extends ComponentProps<"span"> {
  variant?: StatusChipVariant;
  /**
   * Icon shown before the text. Each variant has a default; pass `null` to
   * show text only. The text is always visible, so colour is never the only signal.
   */
  icon?: ReactNode | null;
}

/**
 * A small pill that names a state: "Received", "Needs attention", "Set aside".
 * Styles live in globals.css under `.chip[data-variant]`.
 */
export function StatusChip({
  variant = "neutral",
  icon,
  className,
  children,
  ...props
}: StatusChipProps) {
  const DefaultIcon = DEFAULT_ICONS[variant];
  return (
    <span className={cn("chip", className)} data-variant={variant} {...props}>
      {icon === undefined ? <DefaultIcon aria-hidden="true" /> : icon}
      <span>{children}</span>
    </span>
  );
}
