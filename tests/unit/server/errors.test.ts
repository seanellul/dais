import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The logger reads the environment and may open a pretty-print transport.
// Errors only need `requestLogger(id).error(...)` and `.warn(...)`, so stub
// the module.
const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("@/server/log", () => ({
  requestLogger: () => ({ error: logError, warn: logWarn }),
}));

import {
  AppError,
  errors,
  isAppError,
  isDatabaseUnavailable,
  jsonError,
  statusOf,
  toAppError,
  toErrorResponse,
  validationFromZod,
  type ErrorCode,
} from "@/server/errors";

const REQUEST_ID = "iad1::test-request-0001";

/** A fake `pg` error: a plain Error with the `code` the driver attaches. */
function driverError(code: string, message = "database error"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  logError.mockClear();
  logWarn.mockClear();
});

describe("error factories", () => {
  const cases: [
    name: string,
    error: AppError,
    code: ErrorCode,
    status: number,
    retryable: boolean,
  ][] = [
    ["validation", errors.validation(), "validation", 400, false],
    ["unauthenticated", errors.unauthenticated(), "unauthenticated", 401, false],
    ["forbidden", errors.forbidden(), "forbidden", 403, false],
    ["notFound", errors.notFound(), "not_found", 404, false],
    ["versionConflict", errors.versionConflict(), "version_conflict", 409, false],
    ["assignmentRetired", errors.assignmentRetired(), "assignment_retired", 409, false],
    ["requestReused", errors.requestReused(), "request_reused", 409, false],
    ["setupStale", errors.setupStale(), "setup_stale", 409, false],
    ["divisionFinalized", errors.divisionFinalized(), "division_finalized", 423, false],
    ["rateLimited", errors.rateLimited(), "rate_limited", 429, true],
    ["dbUnavailable", errors.dbUnavailable(), "db_unavailable", 503, true],
    ["internal", errors.internal(), "internal", 500, false],
  ];

  it.each(cases)(
    "%s has the agreed code, status and retryable flag",
    (_n, error, code, status, retryable) => {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(error.message.length).toBeGreaterThan(0);
    },
  );

  it("uses tournament words, not engineering words, in messages", () => {
    const messages = cases.map(([, error]) => error.message.toLowerCase());
    const banned = [
      "conflict",
      "retired",
      "finalized",
      "finalised",
      "assignment",
      "lock",
      "blocked",
    ];
    for (const message of messages) {
      for (const word of banned) expect(message).not.toContain(word);
    }
    expect(errors.versionConflict().message).toContain("two versions");
    expect(errors.assignmentRetired().message).toContain("draw changed");
    expect(errors.divisionFinalized().message).toContain("published");
  });

  it("carries details through", () => {
    const error = errors.assignmentRetired({ successorId: "asg_new" });
    expect(error.details).toEqual({ successorId: "asg_new" });
  });

  it("names the missing thing in notFound", () => {
    expect(errors.notFound("That sheet").message).toBe("That sheet was not found.");
  });

  it("rounds retryAfter up to whole seconds and keeps it at least 1", () => {
    expect(errors.rateLimited(4.2).details).toEqual({ retryAfter: 5 });
    expect(errors.rateLimited(0).details).toEqual({ retryAfter: 1 });
    expect(errors.rateLimited(12).message).toContain("12 seconds");
  });

  it("keeps the cause on dbUnavailable and internal", () => {
    const cause = new Error("connect ECONNREFUSED");
    expect(errors.dbUnavailable(cause).cause).toBe(cause);
    expect(errors.internal(cause).cause).toBe(cause);
  });
});

describe("validationFromZod", () => {
  it("lists one issue per bad field with a dotted path", () => {
    const schema = z.object({ scores: z.object({ overall: z.number().max(103) }) });
    const result = schema.safeParse({ scores: { overall: 150 } });
    if (result.success) throw new Error("expected a parse failure");

    const error = validationFromZod(result.error);
    expect(error.code).toBe("validation");
    expect(error.status).toBe(400);
    expect(error.details).toEqual({
      issues: [{ path: "scores.overall", message: expect.any(String) }],
    });
  });
});

describe("isDatabaseUnavailable", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"])(
    "recognises the socket error %s",
    (code) => {
      expect(isDatabaseUnavailable(driverError(code))).toBe(true);
    },
  );

  it.each(["57P01", "57P02", "57P03", "08000", "08003", "08006", "53300"])(
    "recognises the Postgres SQLSTATE %s",
    (code) => {
      expect(isDatabaseUnavailable({ code, message: "server says no" })).toBe(true);
    },
  );

  it.each([
    "timeout exceeded when trying to connect",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "the database system is starting up",
  ])("recognises the message %j", (message) => {
    expect(isDatabaseUnavailable(new Error(message))).toBe(true);
  });

  it("follows a Drizzle-style cause chain and an AggregateError", () => {
    const wrapped = new Error("Failed query: select 1", { cause: driverError("ECONNREFUSED") });
    expect(isDatabaseUnavailable(wrapped)).toBe(true);

    const aggregate = new AggregateError([driverError("ECONNREFUSED")], "connect failed");
    expect(isDatabaseUnavailable(aggregate)).toBe(true);
  });

  it("stops following causes after a few levels", () => {
    let error: Error = driverError("ECONNREFUSED");
    for (let depth = 0; depth < 8; depth += 1) error = new Error("wrapper", { cause: error });
    expect(isDatabaseUnavailable(error)).toBe(false);
  });

  it("leaves ordinary errors alone", () => {
    expect(isDatabaseUnavailable(new TypeError("x is not a function"))).toBe(false);
    expect(isDatabaseUnavailable(driverError("23505", "duplicate key"))).toBe(false);
    expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable(errors.notFound())).toBe(false);
    expect(isDatabaseUnavailable(errors.dbUnavailable())).toBe(true);
  });
});

describe("toAppError", () => {
  it("returns an AppError unchanged and logs nothing", () => {
    const original = errors.forbidden();
    expect(toAppError(original, REQUEST_ID)).toBe(original);
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("wraps an unknown Error as internal and logs the cause under the request id", () => {
    const cause = new TypeError("Cannot read properties of undefined");
    const wrapped = toAppError(cause, REQUEST_ID);

    expect(wrapped.code).toBe("internal");
    expect(wrapped.status).toBe(500);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).not.toContain("Cannot read properties");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toEqual({ err: cause });
  });

  it("wraps a thrown non-Error value too", () => {
    const wrapped = toAppError("boom", REQUEST_ID);
    expect(wrapped.code).toBe("internal");
    expect(wrapped.cause).toBe("boom");
  });

  it("turns a refused connection into a retryable 503 and logs at warn", () => {
    const cause = driverError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    const wrapped = toAppError(cause, REQUEST_ID);

    expect(wrapped.code).toBe("db_unavailable");
    expect(wrapped.status).toBe(503);
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toContain("waking up");
    expect(wrapped.message).not.toContain("10.0.0.5");
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[0]).toEqual({ err: cause });
    expect(logError).not.toHaveBeenCalled();
  });

  it("treats a Postgres shutdown code the same way", () => {
    const wrapped = toAppError({ code: "57P01", message: "terminating connection" }, REQUEST_ID);
    expect(wrapped.code).toBe("db_unavailable");
    expect(wrapped.retryable).toBe(true);
  });
});

describe("toErrorResponse", () => {
  it("produces the agreed body shape for an AppError", () => {
    const body = toErrorResponse(
      errors.divisionFinalized({ finalizedAt: "2026-03-14T15:00:00Z" }),
      REQUEST_ID,
    );
    expect(body).toEqual({
      code: "division_finalized",
      message: expect.any(String),
      retryable: false,
      requestId: REQUEST_ID,
      details: { finalizedAt: "2026-03-14T15:00:00Z" },
    });
  });

  it("omits details when there are none", () => {
    const body = toErrorResponse(errors.unauthenticated(), REQUEST_ID);
    expect("details" in body).toBe(false);
  });

  it("turns an unknown error into a generic internal body with no stack or cause text", () => {
    const body = toErrorResponse(new Error("secret database detail"), REQUEST_ID);
    expect(body.code).toBe("internal");
    expect(body.requestId).toBe(REQUEST_ID);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("secret database detail");
    expect(serialised).not.toContain("stack");
    expect(serialised).not.toContain("errors.test.ts");
  });
});

describe("statusOf", () => {
  it("reads the status from an AppError and defaults to 500", () => {
    expect(statusOf(errors.notFound())).toBe(404);
    expect(statusOf(new Error("x"))).toBe(500);
  });
});

describe("jsonError", () => {
  it("sets the status, no-store caching and the request id header", async () => {
    const response = jsonError(errors.versionConflict(), REQUEST_ID);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(response.headers.get("x-dais")).toBe("1");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      code: "version_conflict",
      retryable: false,
      requestId: REQUEST_ID,
    });
  });

  it("adds Retry-After for rate limits", () => {
    const response = jsonError(errors.rateLimited(20), REQUEST_ID);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("20");
  });

  it("answers 500 with a generic body for unknown errors and logs once", async () => {
    const response = jsonError(new RangeError("out of range"), REQUEST_ID);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("out of range");
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("answers 503 retryable when the database cannot be reached", async () => {
    const response = jsonError(new Error("timeout exceeded when trying to connect"), REQUEST_ID);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "db_unavailable",
      retryable: true,
      requestId: REQUEST_ID,
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("isAppError", () => {
  it("distinguishes AppError from other values", () => {
    expect(isAppError(errors.internal())).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
