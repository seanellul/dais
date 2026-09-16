import type { ReactNode } from "react";

import { cn } from "@/ui/cn";

export type PrintStatus = "provisional" | "published" | "draft";

const STAMPS: Record<PrintStatus, string> = {
  provisional: "Provisional",
  published: "Published",
  draft: "Draft",
};

export interface PrintPageProps {
  /** Document title, e.g. "Door sheet" or "Results, Open division". */
  title: string;
  tournamentName: string;
  /** Already formatted in the venue's time zone, e.g. "14 Feb 2026, 11:04". */
  generatedAt: string;
  status?: PrintStatus;
  organisationName?: string;
  orientation?: "portrait" | "landscape";
  className?: string;
  children: ReactNode;
}

/**
 * One A4 sheet. On screen it looks like paper; in print (print.css) the chrome
 * goes and each PrintPage starts a new page. The header stamp names the
 * tournament, the document, the time it was generated and whether the numbers
 * are provisional; the footer names the organisation.
 *
 * The sheet forces light mode (data-mode="light"), so an organiser previewing
 * in dark mode sees light-mode chips, borders and secondary text on the white
 * paper, not the dark-mode tints. Fonts still follow the theme.
 */
export function PrintPage({
  title,
  tournamentName,
  generatedAt,
  status = "provisional",
  organisationName,
  orientation = "portrait",
  className,
  children,
}: PrintPageProps) {
  return (
    <article
      className={cn("print-page", className)}
      data-orientation={orientation}
      data-mode="light"
    >
      <header className="print-page__header">
        <div>
          <strong className="font-semibold">{tournamentName}</strong>
          <span aria-hidden="true"> · </span>
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <span>Generated {generatedAt}</span>
          <span className="print-page__stamp">{STAMPS[status]}</span>
        </div>
      </header>
      {children}
      <footer className="print-page__footer">
        <span>{organisationName ?? tournamentName}</span>
        <span>{STAMPS[status]}</span>
      </footer>
    </article>
  );
}
