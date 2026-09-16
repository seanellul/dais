import { describe, expect, it } from "vitest";
import {
  driverFor,
  hostOf,
  isPooledNeonHost,
  shouldAutoMigrate,
  sslModeOf,
  tlsOptionFor,
} from "./config";

/** The URL shapes the README and the deployment files document. All invented. */
const NEON_POOLED =
  "postgres://app:secret@ep-sample-123456-pooler.eu-west-2.aws.neon.tech/dais?sslmode=require";
const DOCKER_COMPOSE = "postgres://dais:dais@postgres:5432/dais";
const CI_LOCALHOST = "postgres://postgres:postgres@localhost:5432/dais_test";
const LAN_NO_TLS = "postgres://dais:dais@192.168.1.20:5432/dais?sslmode=disable";

describe("tlsOptionFor", () => {
  it("verifies certificates for a Neon URL with sslmode=require", () => {
    expect(tlsOptionFor(NEON_POOLED)).toEqual({ rejectUnauthorized: true });
  });

  it("uses plain TCP for the Docker Compose Postgres, which has no sslmode", () => {
    expect(tlsOptionFor(DOCKER_COMPOSE)).toBe(false);
  });

  it("uses plain TCP for CI's localhost", () => {
    expect(tlsOptionFor(CI_LOCALHOST)).toBe(false);
  });

  it("honours sslmode=disable on any host", () => {
    expect(tlsOptionFor(LAN_NO_TLS)).toBe(false);
  });

  it("verifies certificates for verify-full, verify-ca, prefer and allow, as pg does", () => {
    for (const mode of ["verify-full", "verify-ca", "prefer", "allow"]) {
      expect(tlsOptionFor(`${DOCKER_COMPOSE}?sslmode=${mode}`)).toEqual({
        rejectUnauthorized: true,
      });
    }
  });

  it("turns verification off only for pg's no-verify", () => {
    expect(tlsOptionFor(`${DOCKER_COMPOSE}?sslmode=no-verify`)).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("reads sslmode when it is not the first parameter", () => {
    expect(tlsOptionFor(`${DOCKER_COMPOSE}?application_name=dais&sslmode=require`)).toEqual({
      rejectUnauthorized: true,
    });
  });
});

describe("sslModeOf", () => {
  it("returns undefined when the URL says nothing", () => {
    expect(sslModeOf(DOCKER_COMPOSE)).toBeUndefined();
    expect(sslModeOf(`${DOCKER_COMPOSE}?sslmode=`)).toBeUndefined();
  });

  it("lower-cases the mode", () => {
    expect(sslModeOf(`${DOCKER_COMPOSE}?sslmode=Require`)).toBe("require");
  });

  it("works on a string new URL() rejects", () => {
    expect(sslModeOf("postgres://u:p@ss@host/db?sslmode=disable")).toBe("disable");
  });
});

describe("hostOf", () => {
  it("returns the host name and nothing else", () => {
    expect(hostOf(NEON_POOLED)).toBe("ep-sample-123456-pooler.eu-west-2.aws.neon.tech");
    expect(hostOf(DOCKER_COMPOSE)).toBe("postgres");
  });

  it("falls back to the text after @ for a URL new URL() rejects", () => {
    expect(hostOf("postgres://u:p@ss@host.example:5432/db")).toBe("host.example");
  });

  it("returns an empty string for nonsense", () => {
    expect(hostOf("not a url")).toBe("");
  });
});

describe("isPooledNeonHost", () => {
  it("recognises the -pooler host", () => {
    expect(isPooledNeonHost(hostOf(NEON_POOLED))).toBe(true);
    expect(isPooledNeonHost("ep-sample-123456.eu-west-2.aws.neon.tech")).toBe(false);
  });
});

describe("driverFor", () => {
  it("picks PGlite when DATABASE_URL is unset or blank", () => {
    expect(driverFor(undefined)).toBe("pglite");
    expect(driverFor("")).toBe("pglite");
    expect(driverFor("   ")).toBe("pglite");
  });

  it("picks pg for any other value", () => {
    expect(driverFor(DOCKER_COMPOSE)).toBe("pg");
  });
});

describe("shouldAutoMigrate", () => {
  it("migrates PGlite by default", () => {
    expect(shouldAutoMigrate("pglite", {})).toBe(true);
  });

  it("never migrates when DB_AUTO_MIGRATE=0", () => {
    expect(shouldAutoMigrate("pglite", { DB_AUTO_MIGRATE: "0" })).toBe(false);
    expect(shouldAutoMigrate("pg", { DB_AUTO_MIGRATE: "0" })).toBe(false);
  });

  it("leaves Postgres alone unless DB_AUTO_MIGRATE=1", () => {
    expect(shouldAutoMigrate("pg", {})).toBe(false);
    expect(shouldAutoMigrate("pg", { DB_AUTO_MIGRATE: "true" })).toBe(false);
    expect(shouldAutoMigrate("pg", { DB_AUTO_MIGRATE: "1" })).toBe(true);
  });

  it("never migrates Postgres from a Vercel preview deployment", () => {
    expect(shouldAutoMigrate("pg", { DB_AUTO_MIGRATE: "1", VERCEL_ENV: "preview" })).toBe(false);
    expect(shouldAutoMigrate("pg", { DB_AUTO_MIGRATE: "1", VERCEL_ENV: "production" })).toBe(true);
  });
});
