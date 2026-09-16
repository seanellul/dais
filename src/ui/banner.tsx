import type { ComponentProps, ReactNode } from "react";
import { Clock, FlaskConical, Info, Lock, WifiOff, type LucideIcon } from "lucide-react";

import { cn } from "@/ui/cn";

export type BannerKind = "provisional" | "offline" | "sandbox" | "readonly" | "info";

const KINDS: Record<BannerKind, { icon: LucideIcon; label: string }> = {
  provisional: { icon: Clock, label: "Provisional" },
  offline: { icon: WifiOff, label: "Waiting for connection" },
  sandbox: { icon: FlaskConical, label: "Sandbox" },
  readonly: { icon: Lock, label: "Read-only" },
  info: { icon: Info, label: "Note" },
};

export interface BannerProps extends Omit<ComponentProps<"div">, "title"> {
  kind: BannerKind;
  /** Bold lead-in. Defaults to the kind's own label. */
  title?: ReactNode;
  /** Optional control on the right, e.g. a "Retry" button. */
  action?: ReactNode;
}

/**
 * A full-width strip that explains a page-level state. It has role="status",
 * so screen readers hear it when it appears. Styles: `.banner[data-kind]`.
 */
export function Banner({ kind, title, action, className, children, ...props }: BannerProps) {
  const { icon: Icon, label } = KINDS[kind];
  return (
    <div role="status" data-kind={kind} className={cn("banner", className)} {...props}>
      <Icon aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <strong className="font-semibold">{title ?? label}</strong>
        {children ? <span className="ml-1">{children}</span> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
