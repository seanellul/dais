import type { Metadata, Viewport } from "next";
import {
  Fraunces,
  Instrument_Serif,
  Inter,
  Inter_Tight,
  JetBrains_Mono,
  Source_Serif_4,
} from "next/font/google";
import { LiveRegionProvider } from "@/ui/live-region";

import "./globals.css";
import "./print.css";

/*
 * Fonts. Each loader sets one CSS variable on <html>; globals.css maps them onto
 * the semantic --type-* tokens per theme. Only the neutral body and display
 * fonts are preloaded; the ESU Cayman and mono fonts download when a page uses
 * them, so the judge phone fetches nothing it does not show.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
  variable: "--font-source-serif-4",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
  preload: false,
  variable: "--font-fraunces",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  preload: false,
  variable: "--font-instrument-serif",
});

const interTight = Inter_Tight({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-inter-tight",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-jetbrains-mono",
});

const fontClassName = [
  inter.variable,
  sourceSerif.variable,
  fraunces.variable,
  instrumentSerif.variable,
  interTight.variable,
  jetbrainsMono.variable,
].join(" ");

export const metadata: Metadata = {
  title: {
    default: "Dais",
    template: "%s · Dais",
  },
  description: "Points-ranked school debate tournaments, scored on phones.",
  applicationName: "Dais",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Judges must be able to zoom the sheet; never lock the viewport.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1117" },
  ],
};

/**
 * The root layout does three things only: loads fonts and styles, mounts the
 * mode and live-region providers, and renders the skip link.
 *
 * It reads no cookie, header or search param. A request API here would make
 * every route dynamic, including the judge app that the service worker must
 * precache and the public page that should be cached. The organiser layout
 * reads the colour-theme cookie itself (see src/ui/colour-theme-scope.tsx).
 *
 * It renders no <main> either: each route group's layout owns its
 * `<main id="main" tabIndex={-1}>`, so a page's header, nav and footer can
 * sit beside main as proper landmarks instead of inside it.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-GB"
      className={`${fontClassName} h-full`}
      // next-themes sets the class and colour-scheme on the client before paint.
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <LiveRegionProvider>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          {children}
        </LiveRegionProvider>
      </body>
    </html>
  );
}
