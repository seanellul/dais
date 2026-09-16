import type { LocalError } from "@/judge/store/types";
export class JudgeApiError extends Error {
  constructor(
    public readonly error: LocalError,
    public readonly status = 0,
  ) {
    super(error.message);
    this.name = "JudgeApiError";
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new JudgeApiError({
      code: "connection",
      message: "Waiting for connection. Your sheet is saved on this phone.",
      retryable: true,
    });
  }
  if (
    response.headers.get("x-dais") !== "1" ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new JudgeApiError({
      code: "connection",
      message: "This connection is showing a sign-in page. Connect to the venue Wi-Fi, then retry.",
      retryable: true,
    });
  let value: {
    ok?: boolean;
    data?: T;
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
    details?: Record<string, unknown>;
  };
  try {
    value = await response.json();
  } catch {
    throw new JudgeApiError({
      code: "connection",
      message:
        "The tournament response could not be read. Your sheet is saved; retry when connected.",
      retryable: true,
    });
  }
  if (!response.ok)
    throw new JudgeApiError(
      {
        code: value.code ?? "internal",
        message:
          value.message ??
          "The tournament could not receive this sheet. Retry or ask the organiser.",
        retryable: value.retryable ?? response.status >= 500,
        requestId: value.requestId,
        details: value.details,
      },
      response.status,
    );
  return (path === "/api/health" ? value : value.data) as T;
}
