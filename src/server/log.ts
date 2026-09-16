/**
 * Structured logging with pino.
 *
 * In production every line is one JSON object, which Vercel and Docker log
 * collectors index. In local development (and not on Vercel) lines go through
 * pino-pretty so they are readable in a terminal.
 *
 * Use `requestLogger(requestId)` inside route handlers and Server Actions so
 * every line from one request carries the same id as the error response.
 */
import pino from "pino";

import { getEnv } from "@/server/env";

export type Logger = pino.Logger;

/**
 * Fields that must never reach a log line. Session tokens, passwords and join
 * codes are the obvious ones; cookie and authorization headers carry them.
 */
const REDACTED_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "joinToken",
  "*.joinToken",
  "req.headers.cookie",
  "req.headers.authorization",
  "headers.cookie",
  "headers.authorization",
];

function createRootLogger(): Logger {
  const env = getEnv();
  const pretty = env.NODE_ENV === "development" && !env.IS_VERCEL;

  return pino({
    level: env.LOG_LEVEL,
    base: { app: "dais" },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,app" },
          },
        }
      : {}),
  });
}

/** The process-wide logger. Prefer `requestLogger` inside a request. */
export const logger: Logger = createRootLogger();

/** A child logger that stamps `requestId` (and any extra bindings) on every line. */
export function requestLogger(requestId: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ requestId, ...bindings });
}

/** A child logger for a subsystem, e.g. `moduleLogger("db")`. */
export function moduleLogger(name: string): Logger {
  return logger.child({ module: name });
}
