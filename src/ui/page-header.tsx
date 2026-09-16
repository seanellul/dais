import type { ReactNode } from "react";

import { cn } from "@/ui/cn";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Small uppercase line above the title, e.g. the tournament name. */
  eyebrow?: ReactNode;
  /** Buttons on the right. Keep to one primary action. */
  actions?: ReactNode;
  /** Id of the h1. The app shell focuses it after navigation. Defaults to "page-title". */
  titleId?: string;
  className?: string;
}

/**
 * The one h1 per page, with an optional subtitle and actions. The h1 has
 * tabIndex -1 so the shell can move focus to it when the route changes.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  titleId = "page-title",
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="text-eyebrow mb-1">{eyebrow}</p> : null}
        <h1 id={titleId} tabIndex={-1} className="text-h1 font-display outline-none">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-body text-text-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
