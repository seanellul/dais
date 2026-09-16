"use client";

import { useId, useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RubricBand } from "@/domain/types";
import { ActionButton } from "@/ui/action-button";
import { BandBar } from "@/ui/band-bar";
import { Banner, type BannerKind } from "@/ui/banner";
import { EmptyState } from "@/ui/empty-state";
import { Kbd } from "@/ui/kbd";
import { NowCard } from "@/ui/now-card";
import { NumberField } from "@/ui/number-field";
import { OverallField } from "@/ui/overall-field";
import { PrintPage } from "@/ui/print-page";
import { ProgressStrip } from "@/ui/progress-strip";
import { RoleTag } from "@/ui/role-tag";
import { SegmentedControl } from "@/ui/segmented-control";
import { SideTag } from "@/ui/side-tag";
import { StatusChip, type StatusChipVariant } from "@/ui/status-chip";
import { StepRow, type StepStatus } from "@/ui/step-row";
import { Stepper } from "@/ui/stepper";
import { StickyActionBar } from "@/ui/sticky-action-bar";
import { Tabular } from "@/ui/tabular";

/* Invented sample data. The real bands live in the tournament's rubric settings. */
const SAMPLE_BANDS: RubricBand[] = [
  { min: 0, max: 59, label: "Needs work", summary: "The case did not hold together." },
  { min: 60, max: 69, label: "Fair", summary: "Some arguments landed; structure was loose." },
  { min: 70, max: 79, label: "Good", summary: "Clear case, engaged with the other side." },
  { min: 80, max: 89, label: "Very good", summary: "Persuasive, well organised, strong rebuttal." },
  { min: 90, max: 103, label: "Excellent", summary: "Rare. Commanding on every count." },
];

const CHIP_VARIANTS: { variant: StatusChipVariant; label: string }[] = [
  { variant: "neutral", label: "Not yet in" },
  { variant: "success", label: "Received" },
  { variant: "warning", label: "Needs attention" },
  { variant: "danger", label: "Won't arrive" },
  { variant: "info", label: "Waiting to send" },
  { variant: "muted-struck", label: "Set aside" },
];

const BANNER_KINDS: BannerKind[] = ["provisional", "offline", "sandbox", "readonly", "info"];

const STEP_STATUSES: { status: StepStatus; title: string; summary: string }[] = [
  { status: "done", title: "Teams", summary: "12 Open teams and 8 Novice teams." },
  { status: "current", title: "Draw", summary: "Random by team code. Seed 4127." },
  { status: "attention", title: "Round 1", summary: "2 sheets missing from Room 4." },
  {
    status: "skipped",
    title: "Round 2",
    summary: "Marked done by the organiser: one judge left early.",
  },
  { status: "todo", title: "Results", summary: "Publish when every sheet is in." },
];

const POI_OPTIONS = [0, 1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: String(n),
  description: n === 0 ? "No points of information taken" : `${n} out of 4`,
}));

const COLOUR_TOKENS = [
  "bg",
  "surface",
  "surface-sunken",
  "surface-raised",
  "text",
  "text-secondary",
  "text-muted",
  "border",
  "border-strong",
  "primary",
  "primary-surface",
  "action",
  "success",
  "success-surface",
  "warning",
  "warning-surface",
  "danger",
  "danger-surface",
  "info",
  "info-surface",
  "side-gov",
  "side-gov-surface",
  "side-opp",
  "side-opp-surface",
  "highlight-surface",
  "band-fill",
  "topbar",
  "teal",
];

/** One theme panel's worth of components. Rendered four times by the gallery page. */
export function Showcase() {
  const [argumentation, setArgumentation] = useState<number | null>(27);
  const [overall, setOverall] = useState<number | null>(84);
  const [poi, setPoi] = useState<string | null>("2");
  const poiLabelId = useId();

  return (
    <div className="mt-6 flex flex-col gap-8">
      <Block title="Type scale">
        <p className="text-display-xl font-display">Results, Open division</p>
        <p className="text-display font-display">Round 2 draw</p>
        <p className="text-h1 font-display">Heading one</p>
        <p className="text-h2 font-display">Heading two</p>
        <p className="text-h3 font-display">Heading three</p>
        <p className="text-body-lg">Body large. Judges score on their own phones.</p>
        <p className="text-body">Body. Received by the tournament at 11:04.</p>
        <p className="text-body-sm text-text-secondary">Body small, secondary. Waiting to send.</p>
        <p className="text-caption text-text-muted">Caption. Never for essential information.</p>
        <p className="text-eyebrow">Eyebrow · Round 2</p>
        <p className="numeral text-numeral-xl">
          <Tabular>103</Tabular>
        </p>
        <p className="font-mono text-mono">seed 4127 · code K7PX2Q</p>
      </Block>

      <Block title="Colour tokens">
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {COLOUR_TOKENS.map((token) => (
            <li key={token} className="flex flex-col gap-1">
              <span
                aria-hidden="true"
                className="block h-8 rounded-sm border border-border"
                style={{ background: `var(--${token})` }}
              />
              <span className="font-mono text-caption text-text-secondary">{token}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton>Publish the draw</ActionButton>
          <Button variant="outline" className="h-11 px-4 text-base">
            Edit draw
          </Button>
          <Button variant="ghost" className="h-11 px-4 text-base">
            Mark done anyway
          </Button>
          <Button variant="destructive" className="h-11 px-4 text-base">
            Discard sheet
          </Button>
          <Button variant="default" className="h-11 px-4 text-base" disabled>
            Publish results
          </Button>
        </div>
      </Block>

      <Block title="Status chips">
        <div className="flex flex-wrap gap-2">
          {CHIP_VARIANTS.map((chip) => (
            <StatusChip key={chip.variant} variant={chip.variant}>
              {chip.label}
            </StatusChip>
          ))}
          <StatusChip variant="success" icon={null}>
            Text only
          </StatusChip>
        </div>
      </Block>

      <Block title="Side and role tags">
        <div className="flex flex-wrap items-center gap-2">
          <SideTag side="government" />
          <SideTag side="opposition" />
          <SideTag side="government" full />
          <SideTag side="opposition" full />
          <RoleTag roleKey="pm" />
          <RoleTag roleKey="lo" />
          <RoleTag roleKey="gm" />
          <RoleTag roleKey="om" />
          <Kbd>g</Kbd>
          <Kbd>d</Kbd>
        </div>
      </Block>

      <Block title="Banners">
        <div className="flex flex-col gap-2">
          {BANNER_KINDS.map((kind) => (
            <Banner
              key={kind}
              kind={kind}
              action={
                kind === "offline" ? (
                  <Button variant="outline" size="sm">
                    Retry
                  </Button>
                ) : undefined
              }
            >
              {BANNER_COPY[kind]}
            </Banner>
          ))}
        </div>
      </Block>

      <Block title="Step rows">
        <ol className="rounded-lg border border-border bg-surface px-2">
          {STEP_STATUSES.map((step, index) => (
            <StepRow
              key={step.status}
              number={index + 1}
              status={step.status}
              title={step.title}
              summary={step.summary}
              action={
                step.status === "current" ? (
                  <ActionButton>Publish the draw</ActionButton>
                ) : undefined
              }
              overflow={
                step.status === "attention" ? (
                  <Button variant="ghost" size="sm">
                    Mark done anyway
                  </Button>
                ) : undefined
              }
            />
          ))}
        </ol>
      </Block>

      <Block title="Now card and progress strip">
        <div className="grid gap-4 sm:grid-cols-2">
          <NowCard
            heading="h3"
            label="Sheets in, Round 1"
            value={23}
            max={30}
            detail="Room 3 is still scoring."
            progressLabel="23 of 30 sheets received"
          />
          <div className="flex flex-col justify-center gap-4">
            <ProgressStrip value={2} max={4} label="2 of 4 scored" />
            <ProgressStrip value={4} max={4} label="4 of 4 scored" />
            <ProgressStrip value={0} max={4} label="0 of 4 scored" />
          </div>
        </div>
      </Block>

      <Block title="Empty state">
        <EmptyState
          icon={<Inbox aria-hidden="true" />}
          title="No sheets yet"
          description="Sheets appear here the moment a judge sends one. Nothing has arrived for this round."
          action={<Button variant="outline">Type in from paper</Button>}
        />
      </Block>

      <Block title="Band bar">
        <div className="flex flex-col gap-3">
          {[45, 72, 95, null].map((value) => (
            <div key={String(value)} className="flex items-center gap-4">
              <Tabular className="w-8 text-right text-body-sm text-text-secondary">
                {value ?? "–"}
              </Tabular>
              <BandBar bands={SAMPLE_BANDS} value={value} className="flex-1" />
            </div>
          ))}
        </div>
      </Block>

      <Block title="Number field">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Argumentation"
            hint="out of 33"
            value={argumentation}
            onValueChange={setArgumentation}
            min={0}
            max={33}
            trailing={<span>Good</span>}
          />
          {/* 40 is above the maximum, so the field shows its own range error. */}
          <NumberField
            label="Rebuttal"
            hint="out of 33"
            value={40}
            onValueChange={() => {}}
            min={0}
            max={33}
          />
        </div>
      </Block>

      <Block title="Overall field">
        <OverallField
          value={overall}
          onValueChange={setOverall}
          bands={SAMPLE_BANDS}
          max={103}
          note="Scores above 90 are very rare."
        />
      </Block>

      <Block title="Segmented control">
        <p id={poiLabelId} className="text-body-sm font-medium">
          Points of information
        </p>
        <SegmentedControl
          labelledBy={poiLabelId}
          label="Points of information"
          options={POI_OPTIONS}
          value={poi}
          onValueChange={setPoi}
        />
      </Block>

      <Block title="Stepper">
        <Stepper steps={["Motion", "Sides", "Roles"]} current={1} label="Before you score" />
      </Block>

      <Block title="Sticky action bar (shown in place)">
        <StickyActionBar status="Saved" className="static rounded-lg border">
          <Button variant="outline">Back</Button>
          <ActionButton>Review sheet</ActionButton>
        </StickyActionBar>
      </Block>

      <Block title="Print page">
        <div className="overflow-hidden rounded-lg">
          <PrintPage
            title="Door sheet"
            tournamentName="Sample Inter-Schools Tournament"
            generatedAt="14 Feb 2026, 11:04"
            status="provisional"
            organisationName="Sample Debating Union"
            className="min-h-0"
          >
            <p className="text-h1 font-display">Room 4</p>
            <table className="mt-4 w-full text-body-sm">
              <caption className="sr-only">Debates in Room 4</caption>
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Government</th>
                  <th scope="col">Opposition</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td>O03 Harbour View</td>
                  <td>O11 Ironshore</td>
                </tr>
                <tr>
                  <td>2</td>
                  <td>O08 Seven Mile</td>
                  <td>O03 Harbour View</td>
                </tr>
              </tbody>
            </table>
          </PrintPage>
        </div>
      </Block>
    </div>
  );
}

const BANNER_COPY: Record<BannerKind, string> = {
  provisional: "3 sheets are still missing. Rankings may change.",
  offline: "Your sheet is safe on this phone and will send when the signal returns.",
  sandbox: "Invented schools and names. Reset any time.",
  readonly: "Results were published at 16:20. Reopen to change them.",
  info: "Round 3 sides are decided by a coin toss in the room.",
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-eyebrow font-sans">{title}</h3>
      {children}
    </div>
  );
}
