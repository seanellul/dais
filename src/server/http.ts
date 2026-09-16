import { ZodError } from "zod";
import { NextResponse } from "next/server";

import { AppError, errors, jsonError, toAppError, validationFromZod } from "@/server/errors";
import { getRequestId, type HeaderReader } from "@/server/request-id";
import { getEnv } from "@/server/env";

export const MAX_JSON_BODY_BYTES = 256 * 1024;

export function json<T>(data: T, init: ResponseInit = {}): NextResponse<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Dais", "1");
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export function httpError(error: unknown, headers: HeaderReader): NextResponse {
  const requestId = getRequestId(headers);
  const response = jsonError(
    error instanceof ZodError ? validationFromZod(error) : toAppError(error, requestId),
    requestId,
  );
  response.headers.set("X-Dais", "1");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function assertSameOrigin(headers: HeaderReader): void {
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site") throw errors.forbidden("That request origin is not allowed.");
  if (origin && origin !== new URL(getEnv().APP_URL).origin)
    throw errors.forbidden("That request origin is not allowed.");
}

export async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) {
    try {
      return await request.json();
    } catch {
      throw errors.validation("Send a JSON request body.");
    }
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new AppError({
          code: "validation",
          status: 413,
          message: "The request is too large.",
        });
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error instanceof Error && error.message.includes("encoded data")) {
      throw errors.validation("The request body is not valid text.");
    }
    throw error;
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw errors.validation("Send valid JSON.");
  }
}

/** Read a named session cookie without requiring a Next request context. */
export function cookieOf(request: Request, name: string): string {
  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
  }
  return "";
}
