/**
 * The shapes the auth Server Actions accept, as zod schemas, plus the
 * FormData-to-object step. Kept apart from the actions so they can be unit
 * tested without Next's request context.
 *
 * Messages are what the form shows next to a field, so they are plain and
 * short. Password strength beyond length is the service's job
 * (`passwordIssue`), so the two never disagree.
 */
import { z } from "zod";

import { validationFromZod, type AppError } from "@/server/errors";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password";

/** Trimmed and lower-cased before the format check, so "  Sam@X.test " passes. */
const email = z
  .string({ error: "Enter a valid email address." })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address." }));
const name = z
  .string({ error: "Enter a name." })
  .trim()
  .min(1, "Enter a name.")
  .max(120, "Use a shorter name.");
const password = z
  .string({ error: "Enter a password." })
  .min(MIN_PASSWORD_LENGTH, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`);

/**
 * Where to go after signing in: a path on this site only. Anything with a
 * scheme or a protocol-relative prefix is dropped, so a crafted link cannot
 * send an organiser elsewhere after they sign in.
 */
const nextPath = z
  .string()
  .optional()
  .transform((value) => {
    if (!value || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
    try {
      const parsed = new URL(value, "http://dais.invalid");
      return parsed.origin === "http://dais.invalid" ? value : undefined;
    } catch {
      return undefined;
    }
  });

export const signUpSchema = z.object({
  orgName: z
    .string({ error: "Enter the organisation's name." })
    .trim()
    .min(1, "Enter the organisation's name.")
    .max(120, "Use a shorter name."),
  email,
  name,
  password,
});

export const signInSchema = z.object({
  email,
  password: z.string({ error: "Enter your password." }).min(1, "Enter your password."),
  next: nextPath,
});

export const createInviteSchema = z.object({
  organisationId: z.uuid({ error: "Choose an organisation." }),
  email,
  role: z.enum(["owner", "organiser"], { error: "Choose a role." }).default("organiser"),
});

export const acceptInviteSchema = z.object({
  token: z.string({ error: "The invite link is incomplete." }).min(1),
  name,
  password,
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** What an action accepts: a submitted form or a plain object from code. */
export type ActionInput = FormData | Record<string, unknown>;

/**
 * Parses an action's input with `schema`. Returns the value, or the
 * `AppError` (400 with one issue per field) the action should hand back.
 */
export function parseInput<T extends z.ZodType>(
  schema: T,
  input: ActionInput,
): { ok: true; value: z.output<T> } | { ok: false; error: AppError } {
  const raw = input instanceof FormData ? fromFormData(input) : input;
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: validationFromZod(result.error, "Check the form and try again.") };
}

/** Text fields only; files are ignored and repeated names keep the first value. */
export function fromFormData(form: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string" && !(key in record)) record[key] = value;
  }
  return record;
}
