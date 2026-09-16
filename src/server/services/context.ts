/**
 * The service context and the one way to open a transaction.
 *
 * Every service call receives a `ServiceContext`: the database handle, who is
 * acting, the request id that ties logs and error responses together, a
 * clock and a logger. Server Actions and route handlers build one with
 * `createContext` after they have resolved the session; tests build one with
 * `testContext` from `tests/integration/helpers.ts`.
 *
 * `withTransaction` is the only place that opens `db.transaction`. It sets the
 * lock and statement timeouts on Postgres so a stuck row can never hold a
 * judge's phone for longer than a few seconds, and it turns driver failures
 * into the one error type the rest of the app understands.
 */
import { sql } from "drizzle-orm";

import { getDbDriver, type Db, type Tx } from "@/server/db";
import { errors, isAppError, isDatabaseUnavailable } from "@/server/errors";
import { requestLogger, type Logger } from "@/server/log";
import { newRequestId } from "@/server/request-id";

/**
 * Who is acting. `user` is a signed-in organiser (a `users` row), `judge` a
 * judge session (a `judges` row), `system` a cron job, CLI or migration, and
 * `demo` the demo simulator. The audit log stores `user` as `organiser`; see
 * `actorTypeOf` in `./audit`.
 */
export type ActorType = "user" | "judge" | "system" | "demo";

/**
 * The acting person or process. `id` is the row id for users and judges and
 * a stable label such as "cron" for the rest. `name` is what history pages
 * show ("Revised at 15:12 by Sam") and what `*_by` text columns store.
 */
export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

/** The actor for work nobody asked for by hand: cron sweeps, migrations, the CLI. */
export const SYSTEM_ACTOR: Actor = { type: "system", id: "system", name: "Dais" };

/** What every service function receives. Build one with `createContext`. */
export interface ServiceContext {
  db: Db;
  actor: Actor;
  /** Appears on every log line and in every error response for this request. */
  requestId: string;
  /** The clock. Tests freeze it; services never call `new Date()` themselves. */
  now: () => Date;
  /** A logger that already carries `requestId`. */
  log: Logger;
}

/**
 * Either the shared handle or a transaction. `Tx` is a `Db` in the type
 * system too, so a function that takes `Queryable` works inside and outside
 * `withTransaction`. Writes should always go through a transaction.
 */
export type Queryable = Db | Tx;

/** What `createContext` needs; everything optional has a sensible default. */
export interface ContextInit {
  db: Db;
  actor: Actor;
  /** Defaults to a fresh id. Pass the one from `getRequestId(headers)` in a request. */
  requestId?: string;
  /** Defaults to the real clock. */
  now?: () => Date;
  /** Defaults to `requestLogger(requestId)` with the actor's type and id bound. */
  log?: Logger;
}

/** Builds a `ServiceContext`, filling in the request id, clock and logger. */
export function createContext(init: ContextInit): ServiceContext {
  const requestId = init.requestId ?? newRequestId();
  return {
    db: init.db,
    actor: init.actor,
    requestId,
    now: init.now ?? (() => new Date()),
    log:
      init.log ?? requestLogger(requestId, { actorType: init.actor.type, actorId: init.actor.id }),
  };
}

/**
 * How long a statement may wait for a row lock before Postgres gives up.
 * Sheets never share a hot row (see the lock map in the plan), so a wait this
 * long means something is wrong and the judge should retry, not hang.
 */
const LOCK_TIMEOUT = "4s";
/** The ceiling for one statement, well inside Vercel's function budget. */
const STATEMENT_TIMEOUT = "8s";

/** SQLSTATE codes: `lock_not_available` and `query_canceled` (statement timeout). */
const TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "57014"]);
/** SQLSTATE `unique_violation`, which callers handle themselves (receipts, codes). */
const UNIQUE_VIOLATION = "23505";

/**
 * Runs `fn` in one database transaction and returns its result.
 *
 * On Postgres the transaction first runs `SET LOCAL lock_timeout` and
 * `SET LOCAL statement_timeout`, so the limits end with the transaction.
 * PGlite has one connection and no contention, so it gets neither.
 *
 * Errors: an `AppError` passes through unchanged. A lock or statement
 * timeout, or a lost connection, becomes `errors.dbUnavailable` (503,
 * retryable) so the judge app backs off and tries again. A unique violation
 * (SQLSTATE 23505) is rethrown as-is because services handle it (a reused
 * receipt, a clashing code); use `isUniqueViolation` to test for it.
 * Anything else is rethrown unchanged and becomes `internal` further up.
 */
export async function withTransaction<T>(
  ctx: ServiceContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await ctx.db.transaction(async (tx) => {
      if (getDbDriver() === "pg") await applyTimeouts(tx);
      return fn(tx);
    });
  } catch (error) {
    throw toTransactionError(error);
  }
}

async function applyTimeouts(tx: Tx): Promise<void> {
  // SET does not take bind parameters, so the values go in as raw text rather
  // than as interpolations (which drizzle would turn into $1 placeholders).
  await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${LOCK_TIMEOUT}'`)}`);
  await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${STATEMENT_TIMEOUT}'`)}`);
}

/** How deep `sqlStateOf` follows `cause` links; drizzle adds one level, node-postgres none. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The Postgres SQLSTATE of an error, if it carries one. Drizzle wraps driver
 * errors in a `DrizzleQueryError` whose `cause` is the driver's error, so the
 * search follows `cause`. Node socket errors also have a `code` (`EPIPE`),
 * which is why a Postgres error is recognised by its `severity` field too.
 */
export function sqlStateOf(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > MAX_CAUSE_DEPTH) return undefined;
  const { code, severity, cause } = error as {
    code?: unknown;
    severity?: unknown;
    cause?: unknown;
  };
  if (typeof code === "string" && typeof severity === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return code;
  }
  return sqlStateOf(cause, depth + 1);
}

/** True when `error` is a Postgres unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/** The error `withTransaction` rethrows for a failure inside the transaction. */
function toTransactionError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const state = sqlStateOf(error);
  if (state === UNIQUE_VIOLATION) return error;
  if (state !== undefined && TIMEOUT_SQLSTATES.has(state)) return errors.dbUnavailable(error);
  if (isDatabaseUnavailable(error)) return errors.dbUnavailable(error);
  return error;
}
