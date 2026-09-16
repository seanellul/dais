/**
 * Request ids tie a log line, an error response and a support question
 * together. An organiser who sees "request id abc" on screen can quote it and
 * we can find the matching log entry.
 *
 * Vercel already gives every request an id (`x-vercel-id`). Other hosts, or
 * a client that wants to correlate its own retries, can send `x-request-id`.
 * Otherwise a fresh UUID is minted.
 */

/** The header name the proxy sets on the request and every response echoes. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Headers consulted, in order of preference. */
const SOURCE_HEADERS = ["x-vercel-id", REQUEST_ID_HEADER] as const;

/**
 * Only plain identifiers are accepted from the network. Anything else (too
 * long, control characters, whitespace) is ignored so a hostile client cannot
 * inject text into logs or error bodies.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9:._-]{1,128}$/;

/** The minimal interface shared by `Headers` and Next's request headers. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Returns the incoming request id when one is present and safe, else a new one. */
export function getRequestId(headers: HeaderReader): string {
  for (const name of SOURCE_HEADERS) {
    const value = headers.get(name);
    if (value && SAFE_REQUEST_ID.test(value)) return value;
  }
  return newRequestId();
}

/** Mints a request id. `globalThis.crypto` exists in Node 19+ and in browsers. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** True when a string is acceptable as a request id. */
export function isSafeRequestId(value: string): boolean {
  return SAFE_REQUEST_ID.test(value);
}
