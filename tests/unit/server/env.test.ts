import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_SESSION_SECRET, getEnv, parseEnv, resetEnvCache } from "@/server/env";

/** A complete, valid production-style set of variables. Invented values. */
const complete = {
  NODE_ENV: "production",
  DATABASE_URL:
    "postgres://dais:secret@ep-example-pooler.us-east-1.aws.neon.tech/dais?sslmode=require",
  PGLITE_DIR: "/data/pglite",
  SESSION_SECRET: "a-session-secret-long-enough-to-pass",
  CRON_SECRET: "cron-secret",
  APP_URL: "https://dais.example.org",
  DEMO_ENABLED: "0",
  LOG_LEVEL: "warn",
  VERCEL: "1",
};

describe("parseEnv", () => {
  it("reads every variable when all are set", () => {
    const { env, warnings } = parseEnv(complete);
    expect(warnings).toEqual([]);
    expect(env).toEqual({
      NODE_ENV: "production",
      DATABASE_URL: complete.DATABASE_URL,
      PGLITE_DIR: "/data/pglite",
      SESSION_SECRET: complete.SESSION_SECRET,
      CRON_SECRET: "cron-secret",
      APP_URL: "https://dais.example.org",
      DEMO_ENABLED: false,
      LOG_LEVEL: "warn",
      IS_VERCEL: true,
    });
  });

  it("applies defaults so `pnpm dev` needs no .env file", () => {
    const { env } = parseEnv({ NODE_ENV: "development" });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGLITE_DIR).toBe("./data/pglite");
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.DEMO_ENABLED).toBe(true);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.IS_VERCEL).toBe(false);
  });

  it("treats an empty DATABASE_URL as unset (PGlite mode)", () => {
    const { env } = parseEnv({ ...complete, DATABASE_URL: "" });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("rejects a DATABASE_URL that is not a postgres URL and never prints its value", () => {
    const attempt = () => parseEnv({ ...complete, DATABASE_URL: "mysql://who:knows@host/db" });
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).not.toThrow(/knows/);
  });

  it("rejects an APP_URL that is not a URL", () => {
    expect(() => parseEnv({ ...complete, APP_URL: "dais.example.org" })).toThrow(/APP_URL/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => parseEnv({ ...complete, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  it("refuses to start in production without a real SESSION_SECRET", () => {
    expect(() => parseEnv({ ...complete, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv({ ...complete, SESSION_SECRET: "too-short" })).toThrow(/SESSION_SECRET/);
  });

  it("falls back to a development secret outside production, with a warning", () => {
    const { env, warnings } = parseEnv({ NODE_ENV: "development" });
    expect(env.SESSION_SECRET).toBe(DEV_SESSION_SECRET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/SESSION_SECRET/);
  });

  it("allows the fallback while `next build` prerenders, because the build is not the server", () => {
    const { env, warnings } = parseEnv({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    });
    expect(env.SESSION_SECRET).toBe(DEV_SESSION_SECRET);
    expect(warnings).toHaveLength(1);
  });

  it("does not warn when a real secret is set outside production", () => {
    const { warnings } = parseEnv({ NODE_ENV: "test", SESSION_SECRET: complete.SESSION_SECRET });
    expect(warnings).toEqual([]);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
    [undefined, true],
  ])("parses DEMO_ENABLED=%s as %s", (value, expected) => {
    const { env } = parseEnv({ ...complete, DEMO_ENABLED: value });
    expect(env.DEMO_ENABLED).toBe(expected);
  });

  it("rejects a DEMO_ENABLED value it does not understand", () => {
    expect(() => parseEnv({ ...complete, DEMO_ENABLED: "yes" })).toThrow(/DEMO_ENABLED/);
  });
});

describe("getEnv", () => {
  afterEach(() => {
    resetEnvCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("parses process.env once and returns the same object afterwards", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", complete.SESSION_SECRET);
    vi.stubEnv("LOG_LEVEL", "silent");
    resetEnvCache();

    const first = getEnv();
    vi.stubEnv("LOG_LEVEL", "debug");
    const second = getEnv();

    expect(second).toBe(first);
    expect(second.LOG_LEVEL).toBe("silent");
  });

  it("prints the fallback warning once, on the first call", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "");
    resetEnvCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    getEnv();
    getEnv();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/SESSION_SECRET/);
  });

  it("re-reads process.env after resetEnvCache", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", complete.SESSION_SECRET);
    vi.stubEnv("APP_URL", "http://first.example");
    resetEnvCache();
    expect(getEnv().APP_URL).toBe("http://first.example");

    vi.stubEnv("APP_URL", "http://second.example");
    resetEnvCache();
    expect(getEnv().APP_URL).toBe("http://second.example");
  });
});
