import { describe, expect, it } from "vitest";

import {
  acceptInviteSchema,
  createInviteSchema,
  fromFormData,
  parseInput,
  signInSchema,
  signUpSchema,
} from "@/server/auth/forms";
import { rateLimitKey, secondsUntilWindowEnds, windowKey } from "@/server/auth/rate-limit";
import { clientIpOf, userAgentOf } from "@/server/auth/request-meta";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("parseInput", () => {
  it("reads a submitted form and normalises the email", () => {
    const result = parseInput(
      signInSchema,
      form({ email: "  Sam@Example.TEST ", password: "hunter22hunter" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe("sam@example.test");
  });

  it("accepts a plain object from code", () => {
    const result = parseInput(signUpSchema, {
      orgName: " Sample Debating Society ",
      email: "sam@example.test",
      name: "Sam Organiser",
      password: "long enough password",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.orgName).toBe("Sample Debating Society");
  });

  it("returns a 400 with one issue per field, never throws", () => {
    const result = parseInput(signUpSchema, form({ email: "not-an-email", password: "short" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.status).toBe(400);
    const issues = result.error.details?.issues as Array<{ path: string; message: string }>;
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["orgName", "email", "name", "password"]));
    expect(issues.find((i) => i.path === "password")?.message).toMatch(/at least 10/);
  });

  it("keeps only same-site paths in `next`", () => {
    const parse = (next: string) =>
      parseInput(signInSchema, { email: "a@b.test", password: "x", next });
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\\\\evil.example",
      "javascript:alert(1)",
      "t",
    ]) {
      const result = parse(bad);
      expect(result.ok && result.value.next).toBeUndefined();
    }
    const good = parse("/t/sample-2026/draw");
    expect(good.ok && good.value.next).toBe("/t/sample-2026/draw");
  });

  it("defaults the invite role to organiser and rejects a made-up one", () => {
    const ok = parseInput(createInviteSchema, {
      organisationId: "11111111-2222-4333-8444-555555555555",
      email: "new@example.test",
    });
    expect(ok.ok && ok.value.role).toBe("organiser");
    const bad = parseInput(createInviteSchema, {
      organisationId: "11111111-2222-4333-8444-555555555555",
      email: "new@example.test",
      role: "viewer",
    });
    expect(bad.ok).toBe(false);
  });

  it("requires the invite token, a name and a long enough password", () => {
    const result = parseInput(acceptInviteSchema, form({ token: "", name: " ", password: "tiny" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.error.details?.issues as Array<{ path: string }>;
    expect(issues.map((i) => i.path).sort()).toEqual(["name", "password", "token"]);
  });
});

describe("fromFormData", () => {
  it("keeps the first value of a repeated field and ignores files", () => {
    const data = new FormData();
    data.append("email", "first@example.test");
    data.append("email", "second@example.test");
    data.append("upload", new Blob(["x"]), "x.txt");
    expect(fromFormData(data)).toEqual({ email: "first@example.test" });
  });
});

describe("request metadata", () => {
  const headersWith = (fields: Record<string, string>) => ({
    get: (name: string) => fields[name.toLowerCase()] ?? null,
  });

  it("takes the nearest proxy address, then trusted platform headers", () => {
    const previousVercel = process.env.VERCEL;
    const previousTrust = process.env.TRUST_PROXY;
    delete process.env.VERCEL;
    delete process.env.TRUST_PROXY;
    expect(clientIpOf(headersWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBeNull();
    process.env.TRUST_PROXY = "1";
    expect(clientIpOf(headersWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe(
      "10.0.0.1",
    );
    delete process.env.TRUST_PROXY;
    process.env.VERCEL = "1";
    expect(clientIpOf(headersWith({ "x-vercel-forwarded-for": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    process.env.TRUST_PROXY = "1";
    expect(clientIpOf(headersWith({ "x-real-ip": " 198.51.100.4 " }))).toBe("198.51.100.4");
    expect(clientIpOf(headersWith({}))).toBeNull();
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrust;
  });

  it("trims a very long user agent", () => {
    expect(userAgentOf(headersWith({ "user-agent": "x".repeat(1000) }))).toHaveLength(300);
    expect(userAgentOf(headersWith({}))).toBeNull();
  });
});

describe("rate limit windows", () => {
  const policy = { limit: 5, windowSeconds: 900 };

  it("builds keys from a scope and parts", () => {
    expect(rateLimitKey("organiser-signin", "email", "sam@example.test")).toBe(
      "organiser-signin:email:sam@example.test",
    );
  });

  it("puts the window start in the stored key so windows never overlap", () => {
    const at = new Date("2026-09-16T10:07:30Z"); // 10:00 window
    const later = new Date("2026-09-16T10:14:59Z");
    const next = new Date("2026-09-16T10:15:00Z");
    expect(windowKey("k", policy, at)).toBe(windowKey("k", policy, later));
    expect(windowKey("k", policy, at)).not.toBe(windowKey("k", policy, next));
  });

  it("reports the seconds left in the window, at least one", () => {
    expect(secondsUntilWindowEnds(policy, new Date("2026-09-16T10:07:30Z"))).toBe(450);
    expect(secondsUntilWindowEnds(policy, new Date("2026-09-16T10:14:59.900Z"))).toBe(1);
  });
});
