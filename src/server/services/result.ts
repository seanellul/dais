/**
 * The result shape every Server Action returns, and `run`, which produces it.
 *
 * Nothing is thrown to the UI: a service throws `AppError`, `run` catches
 * it, logs it under the request id and returns `{ ok: false, error }` with
 * the same body a route handler would send. The UI switches on `error.code`
 * and shows `error.message`.
 */
import {
  errors,
  isAppError,
  isDatabaseUnavailable,
  toErrorResponse,
  type AppError,
  type ErrorResponse,
} from "@/server/errors";

import type { ServiceContext } from "./context";

/** What a Server Action returns: the data, or an error response the UI can show. */
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ErrorResponse };

/**
 * Runs `fn` and wraps the outcome. Expected failures (`AppError`) are logged
 * at info, a database that cannot be reached at warn, and anything else at
 * error with its cause, all through `ctx.log` so the request id is on the
 * line. The error body never carries a stack.
 */
export async function run<T>(ctx: ServiceContext, fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const appError = normalise(error);
    logFailure(ctx, appError, error);
    return { ok: false, error: toErrorResponse(appError, ctx.requestId) };
  }
}

function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (isDatabaseUnavailable(error)) return errors.dbUnavailable(error);
  return errors.internal(error);
}

function logFailure(ctx: ServiceContext, appError: AppError, cause: unknown): void {
  const fields = { code: appError.code, status: appError.status };
  if (appError.code === "internal") {
    ctx.log.error({ ...fields, err: cause }, "Unhandled error");
  } else if (appError.code === "db_unavailable") {
    ctx.log.warn({ ...fields, err: cause }, "Database unavailable");
  } else {
    ctx.log.info(fields, appError.message);
  }
}
