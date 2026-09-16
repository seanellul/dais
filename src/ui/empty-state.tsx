import type { ReactNode } from "react";

import { cn } from "@/ui/cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Exactly one action. An empty state with two buttons is a menu. */
  action?: ReactNode;
  className?: string;
}

/** What a list shows before it has anything in it: a title, a sentence, one action. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="text-text-muted [&>svg]:size-8">{icon}</div> : null}
      <p className="text-h3 font-display text-text">{title}</p>
      {description ? (
        <p className="max-w-prose text-body-sm text-text-secondary">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
