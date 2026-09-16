/**
 * Integration test setup (vitest project "integration").
 *
 * Runs once per test file. By default every file gets a fresh in-memory
 * PGlite database with all migrations applied. Set `DATABASE_URL_TEST` to run
 * the same suite against a real Postgres (CI does, on postgres:16); the tables
 * then persist between files, so tests must use unique slugs and codes.
 *
 * The database modules are imported inside the hooks, after the environment
 * is set: the server's logger validates `process.env` on first import, and
 * the tests want a quiet log level unless one is given. The log level is set
 * at module level because a test file's own imports run before `beforeAll`.
 */
import { afterAll, beforeAll } from "vitest";

process.env.LOG_LEVEL ??= "warn";

beforeAll(async () => {
  if (process.env.DATABASE_URL_TEST) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  } else {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DIR = ":memory:";
  }
  // Opening the handle applies pending migrations (PGlite migrates itself).
  // On Postgres the policy says "do not", so the suite migrates explicitly.
  const { getDb, migrateDb } = await import("../../src/server/db/client");
  await getDb();
  await migrateDb();
});

afterAll(async () => {
  const { closeDb } = await import("../../src/server/db/client");
  await closeDb();
});
