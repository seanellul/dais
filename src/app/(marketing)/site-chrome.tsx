import Link from "next/link";

import { ThemeToggle } from "@/ui/theme-toggle";

/** Placeholder until the repository is public. */
export const GITHUB_URL = "https://github.com/seanellul/dais";

/**
 * The public site's header: wordmark, GitHub link and the colour-mode toggle.
 * Rendered by the marketing layout outside <main>, so it is a banner landmark.
 */
export function SiteHeader() {
  return (
    <header
      data-print="hide"
      className="mx-auto flex w-full max-w-(--width-organiser) items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      <Link href="/" className="font-display text-h3 text-text no-underline" aria-label="Dais home">
        Dais
      </Link>
      <nav aria-label="Site" className="flex items-center gap-3">
        <a
          href={GITHUB_URL}
          rel="noopener noreferrer"
          className="hidden text-body-sm text-text-secondary no-underline hover:text-text hover:underline sm:inline"
        >
          GitHub
        </a>
        <ThemeToggle />
      </nav>
    </header>
  );
}

/** The public site's footer: licence line and secondary links. A contentinfo landmark. */
export function SiteFooter() {
  return (
    <footer data-print="hide" className="mt-auto border-t border-divider">
      <div className="mx-auto flex w-full max-w-(--width-organiser) flex-col gap-3 px-4 py-8 text-body-sm text-text-secondary sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p>
          Dais is open source under the MIT licence. Built for the Conyers Inter-Schools Debate
          Tournament.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-4">
          <a href={GITHUB_URL} rel="noopener noreferrer" className="no-underline hover:underline">
            GitHub
          </a>
          <Link href="/design" className="no-underline hover:underline">
            Design gallery
          </Link>
        </nav>
      </div>
    </footer>
  );
}
