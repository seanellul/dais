import type { Metadata, Route } from "next";
import {
  ArrowRight,
  ExternalLink,
  FileSpreadsheet,
  LayoutDashboard,
  Smartphone,
  type LucideIcon,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { ActionButton } from "@/ui/action-button";
import { cn } from "@/ui/cn";
import { NowCard } from "@/ui/now-card";
import { SideTag } from "@/ui/side-tag";
import { StatusChip, type StatusChipVariant } from "@/ui/status-chip";
import { StepRow, type StepStatus } from "@/ui/step-row";
import { Tabular } from "@/ui/tabular";

import { GITHUB_URL } from "./site-chrome";

export const metadata: Metadata = {
  title: { absolute: "Dais — points-ranked school debate tournaments, scored on phones" },
  description:
    "Dais runs a one-day school debate tournament: the organiser sees every sheet arrive, judges score on their phones offline, and results follow your outlier policy and export to Excel.",
};

/** The judge sample room is wired by the demo track; this is the judge app's home. */
const SAMPLE_ROOM_URL = "/demo/judge" as Route;

/*
 * Everything below is invented sample data. No real school, debater, judge or
 * score appears anywhere in this repository.
 */

interface RoomRow {
  room: string;
  count: string;
  status: string;
  variant: StatusChipVariant;
}

const LIVE_ROOMS: RoomRow[] = [
  { room: "Room 1", count: "3 of 3", status: "Received", variant: "success" },
  { room: "Room 2", count: "3 of 3", status: "Received", variant: "success" },
  { room: "Room 3", count: "2 of 3", status: "Waiting to send", variant: "info" },
  { room: "Room 4", count: "3 of 3", status: "Two versions", variant: "warning" },
  { room: "Room 5", count: "0 of 3", status: "Not yet in", variant: "neutral" },
];

interface RunSheetStep {
  title: string;
  status: StepStatus;
  summary: string;
}

const RUN_SHEET: RunSheetStep[] = [
  {
    title: "Teams",
    status: "done",
    summary: "12 Open teams and 8 Novice teams, codes O01 to N08.",
  },
  { title: "Judges", status: "done", summary: "30 judges. Join cards printed." },
  { title: "Rooms & panels", status: "done", summary: "10 rooms, three judges in each, all day." },
  {
    title: "Draw",
    status: "current",
    summary: "Random by team code. Seed 4127, shown on the page.",
  },
  { title: "Round 1", status: "todo", summary: "Prepared motion. Sides as drawn." },
  { title: "Round 2", status: "todo", summary: "Prepared motion. Sides swap." },
  { title: "Round 3", status: "todo", summary: "Impromptu. Coin toss in the room." },
  { title: "Results", status: "todo", summary: "Publish when every sheet is in, or with a note." },
];

interface JudgeScore {
  judge: string;
  score: number;
  kept: boolean;
}

/*
 * The policy example. With the default policy (one kept range over every
 * round, average ± 2 × sample spread) the debater's nine scores are
 * 80 78 82 · 84 82 45 · 79 81 83: average 77.1, spread 12.2, kept range
 * 52.7 to 101.5. Only the 45 falls outside. Verified against
 * src/domain/scoring in the design track's review.
 */
const TRACE: JudgeScore[] = [
  { judge: "Marisol Vane", score: 84, kept: true },
  { judge: "Cedric Bowen", score: 82, kept: true },
  { judge: "Owen Trask", score: 45, kept: false },
];

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Pillars />
      <RunSheet />
      <Policy />
      <Foundations />
    </>
  );
}

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="mx-auto grid w-full max-w-(--width-organiser) gap-10 px-4 pt-8 pb-16 sm:px-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:px-8 lg:pt-16"
    >
      <div className="max-w-2xl">
        <p className="text-eyebrow">Open source · MIT licence</p>
        <h1 id="hero-title" className="mt-3 text-display font-display text-text sm:text-display-xl">
          Points-ranked school debate tournaments, scored on phones.
        </h1>
        <p className="mt-5 max-w-prose text-body-lg text-text-secondary">
          Dais runs the day. The organiser watches every sheet arrive on one screen. Judges score on
          their own phones, even when the school Wi-Fi drops. Results follow your outlier policy, in
          words first, and land in the director&apos;s Excel workbook.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {/* The demo route creates a per-visitor sandbox, so it must be a POST. */}
          <form method="post" action="/demo">
            <ActionButton type="submit" size="lg">
              Try the live demo
              <ArrowRight aria-hidden="true" />
            </ActionButton>
          </form>
          <a
            href={SAMPLE_ROOM_URL}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-14 px-6 text-body-lg no-underline",
            )}
          >
            Judge a sample room
          </a>
          <a
            href={GITHUB_URL}
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "ghost" }), "h-14 px-4 text-body no-underline")}
          >
            View on GitHub
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
        <p className="mt-4 text-caption text-text-muted">
          The demo is a sandbox with invented schools and names. It resets itself after a day.
        </p>
      </div>
      <LiveBoardVignette />
    </section>
  );
}

/** A slice of the organiser's live board, with invented rooms. */
function LiveBoardVignette() {
  return (
    <div
      aria-label="Example of the live board during a round"
      role="figure"
      className="rounded-xl border border-border bg-surface p-5 elevation-2"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-eyebrow">Round 2 · Live board</p>
        <StatusChip variant="success">Live</StatusChip>
      </div>
      <NowCard
        heading="h3"
        label="Sheets in"
        value={23}
        max={30}
        detail="Room 3 is still scoring. Nothing is missing yet."
        className="mt-3 border-0 bg-transparent p-0 elevation-0"
      />
      <ul className="mt-5 divide-y divide-divider border-t border-divider">
        {LIVE_ROOMS.map((row) => (
          <li key={row.room} className="flex items-center justify-between gap-3 py-2 text-body-sm">
            <span className="font-medium text-text">{row.room}</span>
            <span className="flex items-center gap-3">
              <Tabular className="text-text-muted">{row.count}</Tabular>
              <StatusChip variant={row.variant}>{row.status}</StatusChip>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pillars() {
  return (
    <section aria-labelledby="pillars-title" className="border-y border-divider bg-surface">
      <div className="mx-auto w-full max-w-(--width-organiser) px-4 py-16 sm:px-6 lg:px-8">
        <h2 id="pillars-title" className="sr-only">
          What Dais does
        </h2>
        <div className="grid gap-10 md:grid-cols-3">
          <Pillar icon={LayoutDashboard} title="Organiser sees every sheet arrive">
            The dashboard is a run sheet for the day. Each judge&apos;s sheet appears the moment it
            is received by the tournament, room by room, so nothing goes missing quietly.
          </Pillar>
          <Pillar icon={Smartphone} title="Judges score offline, nothing is lost">
            Judges score on their own phones, one debater at a time. If the signal drops, the sheet
            waits on the phone and sends itself when the connection returns. Paper stays as a
            fallback.
          </Pillar>
          <Pillar
            icon={FileSpreadsheet}
            title="Results follow your outlier policy and export to Excel"
          >
            A score outside the kept range is set aside, with the judge named and the reason in
            words. Results export to the director&apos;s workbook with live formulas.
          </Pillar>
        </div>
      </div>
    </section>
  );
}

function Pillar({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Icon aria-hidden="true" className="size-6 text-primary" />
      <h3 className="mt-4 text-h3 font-display text-text">{title}</h3>
      <p className="mt-2 text-body text-text-secondary">{children}</p>
    </div>
  );
}

function RunSheet() {
  return (
    <section
      aria-labelledby="run-sheet-title"
      className="mx-auto grid w-full max-w-(--width-organiser) gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:px-8"
    >
      <div>
        <p className="text-eyebrow">The dashboard</p>
        <h2 id="run-sheet-title" className="mt-3 text-display font-display text-text">
          One run sheet. Eight steps. Always says what to do next.
        </h2>
        <p className="mt-4 text-body text-text-secondary">
          Every step shows its status in plain words. The next action is the only accent button on
          the page. When something needs attention, the step says why, and an organiser can mark it
          done anyway, with a reason that goes in the history.
        </p>
      </div>
      <ol
        aria-label="Example run sheet"
        className="rounded-xl border border-border bg-surface px-2 py-1 elevation-1"
      >
        {RUN_SHEET.map((step, index) => (
          <StepRow
            key={step.title}
            number={index + 1}
            status={step.status}
            title={step.title}
            summary={step.summary}
          />
        ))}
      </ol>
    </section>
  );
}

function Policy() {
  return (
    <section aria-labelledby="policy-title" className="border-y border-divider bg-surface">
      <div className="mx-auto grid w-full max-w-(--width-organiser) gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="text-eyebrow">The maths, in words</p>
          <h2 id="policy-title" className="mt-3 text-display font-display text-text">
            Set aside, kept, and explained.
          </h2>
          <p className="mt-4 text-body text-text-secondary">
            A debater&apos;s round score is the average of their judges&apos; kept scores. The kept
            range is built from all of the debater&apos;s scores across the day: the average, plus
            or minus twice the spread. A score outside it is set aside. The organiser sees which
            judge gave it and can keep it anyway, with a reason. The policy is written as one
            sentence in Settings, and it is frozen when results are published.
          </p>
        </div>
        <figure className="rounded-xl border border-border bg-bg p-5">
          <figcaption className="flex flex-wrap items-center gap-2 text-body-sm text-text-secondary">
            <span className="font-medium text-text">Priya Natt</span>
            <SideTag side="government" />
            <span>Prime Minister · Round 2 · Room 4</span>
          </figcaption>
          <ul className="mt-4 divide-y divide-divider border-y border-divider">
            {TRACE.map((entry) => (
              <li key={entry.judge} className="flex items-center justify-between gap-3 py-2">
                <span className="text-body text-text">{entry.judge}</span>
                <span className="flex items-center gap-3">
                  <Tabular
                    className={cn(
                      "text-body font-medium",
                      !entry.kept && "text-text-muted line-through",
                    )}
                  >
                    {entry.score}
                  </Tabular>
                  <StatusChip variant={entry.kept ? "success" : "muted-struck"}>
                    {entry.kept ? "Kept" : "Set aside"}
                  </StatusChip>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-body-sm text-text-secondary">
            Priya&apos;s nine scores over three rounds average{" "}
            <Tabular className="font-medium text-text">77</Tabular> with a spread of{" "}
            <Tabular className="font-medium text-text">12</Tabular>, so her kept range is about 53
            to 101. The 45 sits outside it and is set aside. Her Round 2 score is{" "}
            <Tabular className="font-medium text-text">83.0</Tabular>, the average of the two kept
            scores.
          </p>
        </figure>
      </div>
    </section>
  );
}

function Foundations() {
  return (
    <section
      aria-labelledby="foundations-title"
      className="mx-auto w-full max-w-(--width-organiser) px-4 py-16 sm:px-6 lg:px-8"
    >
      <h2 id="foundations-title" className="text-h2 font-display text-text">
        Made for one-day school leagues
      </h2>
      <div className="mt-6 grid gap-8 md:grid-cols-3">
        <div>
          <h3 className="text-body font-semibold text-text">Points-ranked, not win-loss</h3>
          <p className="mt-2 text-body-sm text-text-secondary">
            Two divisions, a random draw by team code, three rounds, and a ranking from
            outlier-trimmed averages. Tab software built for power-pairing does not fit this shape.
          </p>
        </div>
        <div>
          <h3 className="text-body font-semibold text-text">Free to run</h3>
          <p className="mt-2 text-body-sm text-text-secondary">
            Deploys to Vercel and Neon free tiers, or self-hosts with one Docker image and no
            external database. Nothing to pay for a tournament of twenty teams.
          </p>
        </div>
        <div>
          <h3 className="text-body font-semibold text-text">Every override has a reason</h3>
          <p className="mt-2 text-body-sm text-text-secondary">
            Nothing is deleted silently. Corrections, waivers and set-aside decisions are written to
            a history in plain sentences, and results can be reopened with a reason.
          </p>
        </div>
      </div>
    </section>
  );
}
