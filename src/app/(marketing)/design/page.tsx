import type { Metadata } from "next";

import { PageHeader } from "@/ui/page-header";
import { PresentationToggle } from "@/ui/presentation-toggle";
import type { ColourTheme } from "@/ui/theme";

import { Showcase } from "./showcase";

export const metadata: Metadata = {
  title: "Design gallery (development page)",
  robots: { index: false },
};

interface Panel {
  id: string;
  name: string;
  theme: ColourTheme;
  mode: "light" | "dark";
}

const PANELS: Panel[] = [
  { id: "neutral-light", name: "Neutral · light", theme: "neutral", mode: "light" },
  { id: "neutral-dark", name: "Neutral · dark", theme: "neutral", mode: "dark" },
  { id: "esu-light", name: "ESU Cayman · light", theme: "esu", mode: "light" },
  { id: "esu-dark", name: "ESU Cayman · dark", theme: "esu", mode: "dark" },
];

/**
 * Every Dais component, four times: both colour themes in both modes. Each
 * panel forces its own theme and mode with data-theme and data-mode, so the
 * page does not depend on the viewer's settings. The mode toggle in the site
 * header and the presentation toggle here still change the page chrome, which
 * is a useful check of the real switches.
 */
export default function DesignGalleryPage() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Development page"
        title="Design gallery (development page)"
        subtitle="Every Dais component in both themes and both modes, side by side. It ships so a change can be checked on a real phone and a real projector."
        actions={<PresentationToggle />}
      />
      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        {PANELS.map((panel) => (
          <section
            key={panel.id}
            aria-labelledby={`${panel.id}-title`}
            data-theme={panel.theme}
            data-mode={panel.mode}
            className="min-w-0 rounded-xl border border-border bg-bg p-5 text-text sm:p-6"
          >
            <h2 id={`${panel.id}-title`} className="text-h2 font-display">
              {panel.name}
            </h2>
            <Showcase />
          </section>
        ))}
      </div>
    </div>
  );
}
