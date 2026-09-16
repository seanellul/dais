/**
 * The one schema for a judge's sheet. The judge app, the route handler and
 * the organiser's "type in from paper" form all validate through it, so a
 * sheet means the same thing everywhere.
 *
 * Messages never embed an id. The `path` of an issue names the debater or
 * team, so a caller can attach a name when it shows the message.
 */
import { z } from "zod";
import type { Rubric, RubricCategory, SheetPayload } from "@/domain/types";

export interface SheetIssue {
  /** Dot-joined path, e.g. "scores.spk-1.overall". */
  path: string;
  message: string;
}

export type ParseSheetResult =
  { ok: true; data: SheetPayload } | { ok: false; errors: SheetIssue[] };

export interface SheetSchemaOptions {
  rubric: Rubric;
  /** The debaters this sheet must score: no more, no fewer. */
  speakerIds: string[];
  /** The two teams in the debate. When given, a role swap for any other team is an error. */
  teamIds?: string[];
}

/** A number field for one score, with a plain-English message. */
function scoreField(label: string, max: number, integersOnly: boolean) {
  const kind = integersOnly ? "a whole number" : "a number";
  const error = `${label} must be ${kind} between 0 and ${max}.`;
  const base = integersOnly ? z.int({ error }) : z.number({ error });
  return base.min(0, { error }).max(max, { error });
}

function commentField(label: string, maxLength: number) {
  return z
    .string({ error: `${label} must be text.` })
    .trim()
    .max(maxLength, { error: `${label} must be ${maxLength} characters or fewer.` });
}

function categoryMax(rubric: Rubric, key: RubricCategory["key"]): number {
  const category = rubric.categories.find((entry) => entry.key === key);
  return category?.max ?? 0;
}

/** Marks for one debater, validated against the tournament's rubric. */
export function speakerScoreSchema(rubric: Rubric) {
  const whole = rubric.integersOnly;
  return z.object({
    argumentation: scoreField("Argumentation", categoryMax(rubric, "argumentation"), whole),
    rebuttal: scoreField("Rebuttal", categoryMax(rubric, "rebuttal"), whole),
    presentation: scoreField("Presentation", categoryMax(rubric, "presentation"), whole),
    poi: scoreField("Points of information", categoryMax(rubric, "poi"), whole),
    overall: scoreField("Overall score", rubric.overallMax, whole),
    www: commentField("What went well", rubric.commentMaxLength),
    ebi: commentField("Even better if", rubric.commentMaxLength),
  });
}

/** The scores block: marks for exactly the expected debaters. */
function scoresSchema(rubric: Rubric, speakerIds: string[]) {
  const expected = new Set(speakerIds);
  return z
    .record(z.string(), speakerScoreSchema(rubric), { error: "Scores are missing." })
    .superRefine((scores, ctx) => {
      for (const id of speakerIds) {
        if (!(id in scores)) {
          ctx.addIssue({
            code: "custom",
            path: [id],
            message: "One debater's scores are missing.",
          });
        }
      }
      for (const id of Object.keys(scores)) {
        if (!expected.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [id],
            message: "This sheet lists a debater who is not in this debate.",
          });
        }
      }
    });
}

/** Role swaps keyed by team id; limited to the debate's teams when they are known. */
function roleSwapsSchema(teamIds: string[] | undefined) {
  const allowed = teamIds ? new Set(teamIds) : null;
  return z
    .record(z.string(), z.boolean(), {
      error: "Role swaps must map each team id to true or false.",
    })
    .superRefine((swaps, ctx) => {
      if (!allowed) return;
      for (const id of Object.keys(swaps)) {
        if (!allowed.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [id],
            message: "Role swaps must be for the two teams in this debate.",
          });
        }
      }
    });
}

/**
 * A whole sheet. The scores must cover exactly the expected debaters: a
 * missing debater or an unknown id is an error, so a sheet can never be
 * saved against the wrong debate.
 */
export function sheetPayloadSchema({ rubric, speakerIds, teamIds }: SheetSchemaOptions) {
  return z.object({
    scores: scoresSchema(rubric, speakerIds),
    sideFlipped: z.boolean({ error: "Say whether the sides were swapped in the room." }),
    roleSwaps: roleSwapsSchema(teamIds),
  });
}

/** Validate a sheet without throwing. */
export function parseSheetPayload(input: unknown, options: SheetSchemaOptions): ParseSheetResult {
  const result = sheetPayloadSchema(options).safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}
