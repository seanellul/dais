import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy, securityHeaders } from "@/proxy";
import { REQUEST_ID_HEADER } from "@/server/request-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Splits a CSP string into a map of directive -> sources. */
function parseCsp(policy: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives[name] = sources;
  }
  return directives;
}

/**
 * The request header the proxy forwarded to the page or handler. Next carries
 * overridden request headers on the response as `x-middleware-request-<name>`
 * and lists their names in `x-middleware-override-headers`.
 */
function forwardedHeader(response: Response, name: string): string | null {
  const overridden = response.headers.get("x-middleware-override-headers") ?? "";
  if (!overridden.split(",").includes(name)) return null;
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("securityHeaders", () => {
  const production = securityHeaders({ production: true });
  const development = securityHeaders({ production: false });

  it("sets the fixed headers in every environment", () => {
    for (const headers of [production, development]) {
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["Permissions-Policy"]).toContain("camera=(self)");
      expect(headers["Permissions-Policy"]).toContain("microphone=()");
      expect(headers["X-Dais"]).toBe("1");
    }
  });

  it("lists only Permissions-Policy features browsers still recognise", () => {
    expect(production["Permissions-Policy"]).not.toContain("interest-cohort");
  });

  it("sends HSTS only in production", () => {
    expect(production["Strict-Transport-Security"]).toMatch(/^max-age=\d+; includeSubDomains$/);
    expect(development["Strict-Transport-Security"]).toBeUndefined();
  });

  it("allows eval and the dev websocket only in development", () => {
    const prod = parseCsp(production["Content-Security-Policy"] ?? "");
    const dev = parseCsp(development["Content-Security-Policy"] ?? "");

    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toContain("ws:");
    expect(prod["connect-src"]).toEqual(["'self'"]);
  });

  it("locks down framing, objects, base and form targets", () => {
    const csp = parseCsp(production["Content-Security-Policy"] ?? "");
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
  });

  it("lets QR codes render from data and blob URLs", () => {
    const csp = parseCsp(production["Content-Security-Policy"] ?? "");
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(csp["worker-src"]).toContain("'self'");
  });
});

describe("proxy", () => {
  it("keeps a safe client request id, forwards it and echoes it", () => {
    const request = new NextRequest("http://localhost/api/health", {
      headers: { [REQUEST_ID_HEADER]: "client-1" },
    });
    const response = proxy(request);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("client-1");
    expect(forwardedHeader(response, REQUEST_ID_HEADER)).toBe("client-1");
  });

  it("prefers Vercel's id over the client's", () => {
    const request = new NextRequest("http://localhost/api/health", {
      headers: {
        "x-vercel-id": "iad1::abc12-1700000000000-0123456789ab",
        [REQUEST_ID_HEADER]: "client-1",
      },
    });
    const response = proxy(request);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("iad1::abc12-1700000000000-0123456789ab");
    expect(forwardedHeader(response, REQUEST_ID_HEADER)).toBe(
      "iad1::abc12-1700000000000-0123456789ab",
    );
  });

  it("mints one UUID when no id is sent, and uses it on both sides", () => {
    const response = proxy(new NextRequest("http://localhost/t/abc"));
    const echoed = response.headers.get(REQUEST_ID_HEADER);

    expect(echoed).toMatch(UUID);
    expect(forwardedHeader(response, REQUEST_ID_HEADER)).toBe(echoed);
  });

  it("replaces a hostile request id with a fresh UUID", () => {
    const request = new NextRequest("http://localhost/api/health", {
      headers: { [REQUEST_ID_HEADER]: "has spaces and <tags>" },
    });
    const response = proxy(request);
    const echoed = response.headers.get(REQUEST_ID_HEADER);

    expect(echoed).toMatch(UUID);
    expect(forwardedHeader(response, REQUEST_ID_HEADER)).toBe(echoed);
  });

  it("applies every security header and lets the request continue", () => {
    const response = proxy(new NextRequest("http://localhost/"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    for (const [name, value] of Object.entries(
      securityHeaders({ production: process.env.NODE_ENV === "production" }),
    )) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
