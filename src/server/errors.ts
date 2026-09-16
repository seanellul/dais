/**
 * One error type for the whole server, and one shape for every error response.
 *
 * Services throw `AppError`s. Route handlers catch them and reply with
 * `jsonError(error, requestId)`. Server Actions catch them and return
 * `{ ok: false, error: toErrorResponse(error, requestId) }`. Nothing else is
 * ever thrown to the UI.
 *
 * The response body is `{ code, message, retryable, requestId, details? }`.
 * `code` is what clients switch on. `message` is plain English an organiser
 * or judge can read. `retryable` tells the judge app whether to try again by
 * itself (a sleeping database) or to ask a person (a published division).
 * Stack traces never leave the server.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

import { requestLogger } from "@/server/log";

export type ErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "assignment_retired"
  | "request_reused"
  | "setup_stale"
  | "division_finalized"
  | "rate_limited"
  | "db_unavailable"
  | "internal";

/** Extra, structured facts about an error. Must be safe to send to a client. */
export type ErrorDetails = Record<string, unknown>;

/** What every non-2xx response and every failed Server Action carries. */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
  details?: ErrorDetails;
}

interface AppErrorInit {
  code: ErrorCode;
  status: number;
  message: string;
  retryable?: boolean;
  details?: ErrorDetails;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "AppError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    if (init.details !== undefined) this.details = init.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Seconds a rate-limited client should wait before trying again. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * The two system messages. `docs/GLOSSARY.md` quotes them under "System";
 * change both places together.
 */
const GENERIC_INTERNAL_MESSAGE =
  "Something went wrong on the tournament server. Try again, or tell the organiser the request id.";
const DB_UNAVAILABLE_MESSAGE = "The tournament server is waking up. Try again in a moment.";

/**
 * Factories for every error code. Messages use the tournament vocabulary
 * (sheet, draw, two versions, published results) because clients show them.
 */
export const errors = {
  /** 400. `details` usually carries `{ issues: [{ path, message }] }`. */
  validation(message = "Some of the information sent is not valid.", details?: ErrorDetails) {
    return new AppError({ code: "validation", status: 400, message, details });
  },

  /** 401. No session, or a session that was signed out. */
  unauthenticated(message = "You need to sign in first.") {
    return new AppError({ code: "unauthenticated", status: 401, message });
  },

  /** 403. Signed in, but not a member of this tournament's organisation. */
  forbidden(message = "You don't have access to this tournament.") {
    return new AppError({ code: "forbidden", status: 403, message });
  },

  /** 404. `what` is a short noun such as "That sheet". */
  notFound(what = "That page or record") {
    return new AppError({ code: "not_found", status: 404, message: `${what} was not found.` });
  },

  /** 409. A sheet was submitted against an older version; the organiser decides. */
  versionConflict(details?: ErrorDetails) {
    return new AppError({
      code: "version_conflict",
      status: 409,
      message:
        "There are now two versions of this sheet. The organiser will choose which one to keep.",
      details,
    });
  },

  /** 409. The draw changed; `details.successorId` points at the replacement sheet. */
  assignmentRetired(details?: ErrorDetails) {
    return new AppError({
      code: "assignment_retired",
      status: 409,
      message: "The draw changed since this sheet was started. Open the new sheet.",
      details,
    });
  },

  /** 409. Same request id, different content. */
  requestReused(details?: ErrorDetails) {
    return new AppError({
      code: "request_reused",
      status: 409,
      message: "This request id was already used with different scores.",
      details,
    });
  },

  /** 409. An organiser saved setup from a page that was out of date. */
  setupStale(details?: ErrorDetails) {
    return new AppError({
      code: "setup_stale",
      status: 409,
      message: "The tournament setup changed since this page was loaded. Reload and try again.",
      details,
    });
  },

  /** 423. Results are published; `details.finalizedAt` says when. */
  divisionFinalized(details?: ErrorDetails) {
    return new AppError({
      code: "division_finalized",
      status: 423,
      message: "Results for this division are published. Ask the organiser to reopen them.",
      details,
    });
  },

  /** 429. `retryAfterSeconds` also becomes the Retry-After header. */
  rateLimited(retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return new AppError({
      code: "rate_limited",
      status: 429,
      retryable: true,
      message: `Too many attempts. Try again in ${seconds} seconds.`,
      details: { retryAfter: seconds },
    });
  },

  /** 503. A sleeping or unreachable database. Clients retry with backoff. */
  dbUnavailable(cause?: unknown) {
    return new AppError({
      code: "db_unavailable",
      status: 503,
      retryable: true,
      message: DB_UNAVAILABLE_MESSAGE,
      cause,
    });
  },

  /** 500. Anything we did not expect. The cause stays in the logs. */
  internal(cause?: unknown) {
    return new AppError({
      code: "internal",
      status: 500,
      message: GENERIC_INTERNAL_MESSAGE,
      cause,
    });
  },
};

/** Turns a zod parse failure into a 400 with one entry per bad field. */
export function validationFromZod(error: ZodError, message?: string): AppError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return errors.validation(message, { issues });
}

/**
 * Error codes that mean "the database could not be reached right now".
 *
 * Node socket errors come first (`ECONNREFUSED` when Postgres is down,
 * `ETIMEDOUT`/`ECONNRESET` when Neon drops a suspended compute's socket,
 * `ENOTFOUND`/`EAI_AGAIN` when DNS is not answering). The rest are Postgres
 * SQLSTATE codes: class 08 is "connection exception", 57P01–57P03 are the
 * server shutting down, crashing or still starting up, and 53300 is "too many
 * connections", which the Neon free plan returns under a burst of submissions.
 */
const DB_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

/**
 * Messages `pg` raises without a code: the pool's own connection timeout, a
 * socket that closed mid-query, and Postgres refusing connections while it
 * boots (Neon's compute reports this for the first second or two).
 */
const DB_UNAVAILABLE_MESSAGES: readonly RegExp[] = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /the database system is (starting up|shutting down)/i,
  /server closed the connection unexpectedly/i,
];

/** How deep `isDatabaseUnavailable` follows `cause` and `errors` links. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when `error` (or an error it wraps) says the database could not be
 * reached. Drizzle wraps driver errors in a `DrizzleQueryError` whose `cause`
 * is the `pg` error, and Node reports a refused connection to a host with
 * several addresses as an `AggregateError`, so the check follows `cause` and
 * `errors` a few levels down.
 */
export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > MAX_CAUSE_DEPTH) return false;
  if (isAppError(error)) return error.code === "db_unavailable";

  const {
    code,
    message,
    cause,
    errors: nested,
  } = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof code === "string" && DB_UNAVAILABLE_CODES.has(code)) return true;
  if (typeof message === "string" && DB_UNAVAILABLE_MESSAGES.some((re) => re.test(message))) {
    return true;
  }
  if (cause !== undefined && isDatabaseUnavailable(cause, depth + 1)) return true;
  return Array.isArray(nested) && nested.some((e) => isDatabaseUnavailable(e, depth + 1));
}

/**
 * Normalises anything that was thrown into an `AppError`.
 *
 * A database that cannot be reached becomes `db_unavailable` (503, retryable),
 * logged at warn: the judge app backs off and tries again, and a sleeping Neon
 * compute recovers within that retry budget. Everything else becomes
 * `internal` and is logged at error with its cause under the request id, so
 * the generic message on screen can be matched to the real failure.
 */
export function toAppError(error: unknown, requestId: string): AppError {
  if (isAppError(error)) return error;
  if (isDatabaseUnavailable(error)) {
    requestLogger(requestId).warn({ err: error }, "Database unavailable");
    return errors.dbUnavailable(error);
  }
  requestLogger(requestId).error({ err: error }, "Unhandled error");
  return errors.internal(error);
}

/** The body of an error response or a failed Server Action. Never includes a stack. */
export function toErrorResponse(error: unknown, requestId: string): ErrorResponse {
  const appError = toAppError(error, requestId);
  const body: ErrorResponse = {
    code: appError.code,
    message: appError.message,
    retryable: appError.retryable,
    requestId,
  };
  if (appError.details !== undefined) body.details = appError.details;
  return body;
}

/** The HTTP status for an error, for handlers that build their own response. */
export function statusOf(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}

/**
 * A JSON error response for a route handler: correct status, no caching, the
 * request id echoed in a header, and `Retry-After` when the client was
 * rate limited. The `X-Dais` header lets the judge app tell our responses
 * apart from a captive portal's.
 */
export function jsonError(error: unknown, requestId: string): NextResponse<ErrorResponse> {
  const appError = toAppError(error, requestId);
  const body = toErrorResponse(appError, requestId);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "X-Dais": "1",
  });
  const retryAfter = appError.details?.retryAfter;
  if (typeof retryAfter === "number") headers.set("Retry-After", String(retryAfter));
  return NextResponse.json(body, { status: appError.status, headers });
}
