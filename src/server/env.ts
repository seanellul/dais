/**
 * Validated access to process.env.
 *
 * Every server module that needs configuration calls `getEnv()` instead of
 * reading `process.env` directly. The variables are parsed once with zod, so a
 * typo or a missing secret fails at boot with a clear message rather than
 * halfway through a tournament.
 *
 * Values are never printed: error messages name the variable and the rule it
 * broke, nothing else.
 */
import { z } from "zod";

/** pino log levels, plus "silent" for tests. */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type NodeEnv = "development" | "test" | "production";

/** The typed, validated configuration the rest of the server reads. */
export interface Env {
  NODE_ENV: NodeEnv;
  /** Postgres connection string. Unset means "use the embedded PGlite database". */
  DATABASE_URL: string | undefined;
  /** Directory for the embedded PGlite database when DATABASE_URL is unset. */
  PGLITE_DIR: string;
  /** Signs cookies and peppers session hashes. At least 16 characters. */
  SESSION_SECRET: string;
  /** Bearer token that protects `/api/cron/*`. Unset disables cron routes. */
  CRON_SECRET: string | undefined;
  /** Public origin used in QR codes, join links and emails. */
  APP_URL: string;
  /** False on self-hosted instances that must not expose the public demo. */
  DEMO_ENABLED: boolean;
  LOG_LEVEL: LogLevel;
  /** True when running on Vercel (the platform sets VERCEL=1). */
  IS_VERCEL: boolean;
}

/** The result of one parse: the env plus any warnings worth printing once. */
export interface ParsedEnv {
  env: Env;
  warnings: string[];
}

/**
 * Used when SESSION_SECRET is missing outside production. It is public by
 * definition, so production refuses to start with it.
 */
export const DEV_SESSION_SECRET = "dais-development-only-secret-not-for-production";

const SESSION_SECRET_MIN_LENGTH = 16;

/** Treats "" and whitespace as unset, so `FOO=` in a .env file means "default". */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema);

const schema = z.object({
  NODE_ENV: optionalString(z.enum(["development", "test", "production"]).default("development")),
  DATABASE_URL: optionalString(z.url({ protocol: /^postgres(ql)?$/ }).optional()),
  PGLITE_DIR: optionalString(z.string().default("./data/pglite")),
  SESSION_SECRET: optionalString(z.string().min(SESSION_SECRET_MIN_LENGTH)),
  CRON_SECRET: optionalString(z.string().optional()),
  APP_URL: optionalString(z.url().default("http://localhost:3000")),
  DEMO_ENABLED: optionalString(z.enum(["0", "1", "false", "true"]).default("1")),
  LOG_LEVEL: optionalString(z.enum(LOG_LEVELS).default("info")),
  VERCEL: optionalString(z.string().optional()),
});

type EnvSource = Record<string, string | undefined>;

/**
 * The development fallback for SESSION_SECRET is allowed outside production
 * and during `next build` (NEXT_PHASE is set by Next.js). The build process
 * only prerenders pages; the running server is a separate process that is
 * validated again with the real variables.
 */
function allowsSessionSecretFallback(source: EnvSource): boolean {
  const nodeEnv = source.NODE_ENV ?? "development";
  return nodeEnv !== "production" || source.NEXT_PHASE === "phase-production-build";
}

function describeIssues(error: z.ZodError): string {
  const parts = error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  return `Invalid environment variables. ${parts.join("; ")}. See .env.example.`;
}

/**
 * Parses a set of variables without touching the cache. Pure apart from the
 * source it is given, which makes it easy to test.
 */
export function parseEnv(source: EnvSource = process.env): ParsedEnv {
  const warnings: string[] = [];
  const input: EnvSource = { ...source };

  const secret = input.SESSION_SECRET ?? "";
  if (secret.length < SESSION_SECRET_MIN_LENGTH && allowsSessionSecretFallback(source)) {
    input.SESSION_SECRET = DEV_SESSION_SECRET;
    warnings.push(
      "SESSION_SECRET is missing or shorter than 16 characters. Using the development fallback. " +
        "Set SESSION_SECRET before deploying.",
    );
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(describeIssues(result.error));
  }

  const parsed = result.data;
  const env: Env = {
    NODE_ENV: parsed.NODE_ENV,
    DATABASE_URL: parsed.DATABASE_URL,
    PGLITE_DIR: parsed.PGLITE_DIR,
    SESSION_SECRET: parsed.SESSION_SECRET,
    CRON_SECRET: parsed.CRON_SECRET,
    APP_URL: parsed.APP_URL,
    DEMO_ENABLED: parsed.DEMO_ENABLED === "1" || parsed.DEMO_ENABLED === "true",
    LOG_LEVEL: parsed.LOG_LEVEL,
    IS_VERCEL: parsed.VERCEL !== undefined,
  };
  return { env, warnings };
}

let cached: Env | undefined;

/**
 * The validated environment, parsed once per process. Warnings are printed
 * once, on the first call. Throws when a variable is invalid, which is the
 * intended way for a misconfigured deployment to fail: early and loudly.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const { env, warnings } = parseEnv();
  for (const warning of warnings) {
    console.warn(`[dais] ${warning}`);
  }
  cached = env;
  return cached;
}

/** Forgets the cached env. For tests only. */
export function resetEnvCache(): void {
  cached = undefined;
}
