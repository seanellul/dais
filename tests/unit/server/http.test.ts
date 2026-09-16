import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertSameOrigin,
  cookieOf,
  httpError,
  json,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "@/server/http";

function streamRequest(chunks: Uint8Array[]) {
  return new Request("http://localhost:3000/test", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}
describe("JSON HTTP boundary", () => {
  it("preserves a multibyte character split across byte chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"é🦉"}');
    expect(
      await readJsonBody(streamRequest([...bytes].map((byte) => Uint8Array.of(byte)))),
    ).toEqual({ name: "é🦉" });
  });
  it("bounds actual stream bytes even without Content-Length", async () => {
    const request = streamRequest([new Uint8Array(MAX_JSON_BODY_BYTES), Uint8Array.of(32)]);
    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 413 });
  });
  it("makes malformed JSON and invalid UTF-8 readable 400 errors", async () => {
    for (const bytes of [new TextEncoder().encode("{"), Uint8Array.of(255)]) {
      try {
        await readJsonBody(streamRequest([bytes]));
        throw new Error("Expected failure");
      } catch (error) {
        const response = httpError(error, new Headers({ "x-request-id": "test-http" }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "validation",
          requestId: "test-http",
          retryable: false,
        });
      }
    }
  });
  it("turns shape failures into validation errors", () => {
    const parsed = z.object({ id: z.string() }).safeParse({ id: 5 });
    if (parsed.success) throw new Error("Expected shape failure");
    expect(httpError(parsed.error, new Headers()).status).toBe(400);
  });
  it("rejects foreign origins and cross-site requests", () => {
    expect(() => assertSameOrigin(new Headers({ origin: "https://foreign.test" }))).toThrow();
    expect(() => assertSameOrigin(new Headers({ "sec-fetch-site": "cross-site" }))).toThrow();
    expect(() => assertSameOrigin(new Headers({ origin: "http://localhost:3000" }))).not.toThrow();
  });
  it("marks JSON and errors as Dais responses without cache", () => {
    const response = json({ value: 1 });
    expect(response.headers.get("x-dais")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("reads only an exactly named cookie", () => {
    const request = new Request("http://localhost:3000", {
      headers: { cookie: "other.dais.judge=wrong; dais.judge=right; suffix=unused" },
    });
    expect(cookieOf(request, "dais.judge")).toBe("right");
  });
});
