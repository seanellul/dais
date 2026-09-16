import { describe, expect, it } from "vitest";

import {
  getRequestId,
  isSafeRequestId,
  newRequestId,
  REQUEST_ID_HEADER,
} from "@/server/request-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("getRequestId", () => {
  it("prefers Vercel's id", () => {
    const headers = new Headers({
      "x-vercel-id": "iad1::abc12-1700000000000-0123456789ab",
      [REQUEST_ID_HEADER]: "client-1",
    });
    expect(getRequestId(headers)).toBe("iad1::abc12-1700000000000-0123456789ab");
  });

  it("falls back to x-request-id", () => {
    expect(getRequestId(new Headers({ [REQUEST_ID_HEADER]: "client-1" }))).toBe("client-1");
  });

  it("mints a UUID when neither header is present", () => {
    expect(getRequestId(new Headers())).toMatch(UUID);
  });

  it("ignores values that could pollute logs", () => {
    // `Headers` itself rejects control characters, so use a bare reader here.
    const hostile = { get: () => 'abc\n{"injected":true}' };
    expect(getRequestId(hostile)).toMatch(UUID);
    const tooLong = new Headers({ [REQUEST_ID_HEADER]: "x".repeat(129) });
    expect(getRequestId(tooLong)).toMatch(UUID);
    const spaced = new Headers({ [REQUEST_ID_HEADER]: "has a space" });
    expect(getRequestId(spaced)).toMatch(UUID);
  });
});

describe("isSafeRequestId", () => {
  it.each(["abc", "iad1::x-1", "a.b_c:d", "x".repeat(128)])("accepts %s", (value) => {
    expect(isSafeRequestId(value)).toBe(true);
  });

  it.each(["", "with space", "tab\there", "x".repeat(129), "<script>"])("rejects %j", (value) => {
    expect(isSafeRequestId(value)).toBe(false);
  });
});

describe("newRequestId", () => {
  it("returns distinct UUIDs", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});
