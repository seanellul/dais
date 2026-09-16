/**
 * Tournament settings: the default preset and a zod schema for round-trips
 * through the `tournaments.settings` jsonb column.
 *
 * The default preset is the Conyers Inter-Schools Debate Tournament as run
 * today: two divisions, three rounds (the last impromptu), a 33/33/33/4
 * rubric with an independent Overall score out of 103, and the bands from
 * the Guide to Judging.
 */
import { z } from "zod";
import { DEFAULT_ROLE_LABELS, type RubricBand, type TournamentSettings } from "@/domain/types";

/** The Guide to Judging's bands for the Overall score out of 103. */
export const DEFAULT_BANDS: RubricBand[] = [
  {
    min: 87,
    max: 103,
    label: "Excellent",
    summary: "Speech was brilliant; would hire as your own lawyer at trial",
  },
  { min: 81, max: 86, label: "Very good", summary: "Solid and polished; did what they had to do" },
  {
    min: 71,
    max: 80,
    label: "Competent",
    summary: "Identified the major issues but lacked some key components",
  },
  { min: 66, max: 70, label: "Fair", summary: "Struggling to put together a persuasive case" },
  { min: 40, max: 65, label: "Ineffective", summary: "Needs a lot more work; chaotic" },
  { min: 0, max: 39, label: "Below the rubric's range", summary: "Check this score" },
];

export const DEFAULT_SETTINGS: TournamentSettings = {
  divisions: [
    { code: "Open", name: "Open (competitive)" },
    { code: "Novice", name: "Novice (learning)" },
  ],
  rounds: [
    { number: 1, format: "prepared", sidesDecided: "in-advance" },
    { number: 2, format: "prepared", sidesDecided: "in-advance" },
    { number: 3, format: "impromptu", sidesDecided: "in-room" },
  ],
  rubric: {
    categories: [
      { key: "argumentation", label: "Argumentation", max: 33 },
      { key: "rebuttal", label: "Rebuttal", max: 33 },
      { key: "presentation", label: "Presentation", max: 33 },
      { key: "poi", label: "Points of information", max: 4 },
    ],
    overallMax: 103,
    bands: DEFAULT_BANDS,
    noRebuttalScore: 13,
    integersOnly: true,
    commentMaxLength: 4000,
  },
  roles: { ...DEFAULT_ROLE_LABELS },
  timings: {
    prepared: [5, 7, 7, 7, 2],
    impromptu: [4, 5, 5, 5, 1],
  },
  panelMode: "fixed-room",
  judgesPerRoom: 3,
  feedbackRequired: false,
};

const label = z.string().trim().min(1, { error: "A label is required." });
const minutes = z.number().min(0).max(60);
const fiveMinutes = z.tuple([minutes, minutes, minutes, minutes, minutes]);

/**
 * True when the bands, sorted by their floors, run from 0 to `top` with no
 * gaps or overlaps: each band starts one point above the band below it.
 * `bandFor` returns null in a gap and the first match in an overlap, so a
 * saved rubric must pass this before the judge sheet can trust its labels.
 */
export function bandsCover(bands: RubricBand[], top: number): boolean {
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  if (sorted.length === 0 || sorted[0].min !== 0) return false;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].min !== sorted[i - 1].max + 1) return false;
  }
  return sorted[sorted.length - 1].max === top;
}

export const rubricBandSchema = z.object({
  min: z.number().min(0),
  max: z.number().min(0),
  label,
  summary: z.string().trim(),
});

export const rubricSchema = z
  .object({
    categories: z
      .array(
        z.object({
          key: z.enum(["argumentation", "rebuttal", "presentation", "poi"]),
          label,
          max: z.number().int().min(1),
        }),
      )
      .min(1),
    overallMax: z.number().int().min(1),
    bands: z.array(rubricBandSchema).min(1),
    noRebuttalScore: z.number().min(0),
    integersOnly: z.boolean(),
    commentMaxLength: z.number().int().min(1),
  })
  .superRefine((rubric, ctx) => {
    const keys = rubric.categories.map((category) => category.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Each rubric category can appear only once.",
      });
    }
    let bandsWellFormed = true;
    for (const [index, band] of rubric.bands.entries()) {
      if (band.min > band.max) {
        bandsWellFormed = false;
        ctx.addIssue({
          code: "custom",
          path: ["bands", index],
          message: `The band "${band.label}" has a lower bound above its upper bound.`,
        });
      }
    }
    if (bandsWellFormed && !bandsCover(rubric.bands, rubric.overallMax)) {
      ctx.addIssue({
        code: "custom",
        path: ["bands"],
        message: `The bands must run from 0 to ${rubric.overallMax} with no gaps or overlaps.`,
      });
    }
    const rebuttalMax = rubric.categories.find((category) => category.key === "rebuttal")?.max;
    if (rebuttalMax !== undefined && rubric.noRebuttalScore > rebuttalMax) {
      ctx.addIssue({
        code: "custom",
        path: ["noRebuttalScore"],
        message: `The score for no rebuttal must be between 0 and ${rebuttalMax}, the Rebuttal maximum.`,
      });
    }
  });

export const settingsSchema = z.object({
  divisions: z
    .array(z.object({ code: z.string().trim().min(1), name: label }))
    .min(1, { error: "At least one division is required." }),
  rounds: z
    .array(
      z.object({
        number: z.number().int().min(1),
        format: z.enum(["prepared", "impromptu"]),
        sidesDecided: z.enum(["in-advance", "in-room"]),
      }),
    )
    .min(1, { error: "At least one round is required." }),
  rubric: rubricSchema,
  roles: z.object({ pm: label, lo: label, gm: label, om: label }),
  timings: z.object({ prepared: fiveMinutes, impromptu: fiveMinutes }),
  panelMode: z.enum(["fixed-room", "per-round"]),
  judgesPerRoom: z.number().int().min(1).max(5),
  feedbackRequired: z.boolean(),
});

export type SettingsIssue = { path: string; message: string };
export type ParseSettingsResult =
  { ok: true; data: TournamentSettings } | { ok: false; errors: SettingsIssue[] };

/**
 * Parse a settings value read back from jsonb. Never throws; returns the
 * plain-English issues so a caller can show or log them.
 */
export function parseSettings(input: unknown): ParseSettingsResult {
  const result = settingsSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}
