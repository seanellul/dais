/**
 * The one database handle for the whole server.
 *
 * `getDb()` picks a driver from the environment, opens it once, applies
 * pending migrations when the auto-migrate policy allows, and hands back the
 * same Drizzle instance to every caller. `migrateDb()` applies migrations
 * regardless of the policy (`pnpm db:migrate`). `closeDb()` releases the
 * handle (tests call it between files).
 *
 * Drivers
 * - `DATABASE_URL` set: Postgres through a `pg` pool (production on Neon,
 *   `docker compose`, CI). TLS follows the URL's `sslmode`; see
 *   `tlsOptionFor` in `./config`. On Vercel the pool is registered with
 *   `attachDatabasePool` so idle connections close before the function
 *   instance is frozen, and a warning is logged when the host is not Neon's
 *   pooled endpoint (`-pooler`), which the free plan needs under load.
 * - `DATABASE_URL` unset or blank: PGlite, an embedded Postgres, stored at
 *   `PGLITE_DIR` (default `./data/pglite`). The value `:memory:` keeps it in
 *   memory, which is what the integration tests use.
 *
 * Migrations on open
 * - PGlite migrates itself, unless `DB_AUTO_MIGRATE=0`.
 * - Postgres migrates itself only with `DB_AUTO_MIGRATE=1`, and never from a
 *   Vercel preview deployment. CI (`migrate-production.yml`) and the Docker
 *   entrypoint migrate before the app starts. See `shouldAutoMigrate`.
 *
 * This module reads `process.env` directly rather than through `getEnv()`:
 * the integration tests switch driver and directory between files, and the
 * validated env is parsed once per process.
 */
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { attachDatabasePool } from "@vercel/functions";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { moduleLogger } from "../log";
import {
  driverFor,
  hostOf,
  isPooledNeonHost,
  shouldAutoMigrate,
  tlsOptionFor,
  type DbDriver,
} from "./config";
import { applyMigrations, countAppliedMigrations } from "./migrate";
import * as relations from "./relations";
import * as tables from "./schema";

export type { DbDriver } from "./config";

/** Tables and relations together; this is what `db.query` understands. */
export const schema = { ...tables, ...relations };
export type Schema = typeof schema;

/** A Drizzle database, whichever driver is behind it. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** The handle a `db.transaction(async (tx) => ...)` callback receives. */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** What `migrateDb()` reports back. */
export interface MigrationReport {
  driver: DbDriver;
  /** Migrations applied by this call. Zero when the database was already current. */
  applied: number;
  /** Migrations recorded in the database after this call. */
  recorded: number;
}

interface DbHandle {
  db: Db;
  driver: DbDriver;
  /** Where the database lives, for log lines. A host name or a directory; never a password. */
  location: string;
  /** Migrations the open step applied and nobody has reported yet. `migrateDb()` claims them. */
  appliedOnOpen: number;
  close: () => Promise<void>;
}

const DEFAULT_PGLITE_DIR = "./data/pglite";

const log = moduleLogger("db");

let handlePromise: Promise<DbHandle> | undefined;

/** Returns the shared database. Safe to call from anywhere on the server. */
export async function getDb(): Promise<Db> {
  return (await getHandle()).db;
}

/** Which driver `getDb()` will use, without opening anything. */
export function getDbDriver(): DbDriver {
  return driverFor(process.env.DATABASE_URL);
}

/**
 * Applies pending migrations now, whatever `DB_AUTO_MIGRATE` says. Safe to
 * call repeatedly: a database that is already current reports `applied: 0`.
 */
export async function migrateDb(): Promise<MigrationReport> {
  const handle = await getHandle();
  const applied = handle.appliedOnOpen + (await applyMigrations(handle.db));
  handle.appliedOnOpen = 0;
  const recorded = await countAppliedMigrations(handle.db);
  log.info({ driver: handle.driver, applied, recorded }, "migrations applied");
  return { driver: handle.driver, applied, recorded };
}

/** Closes the pool or embedded database and forgets it, so `getDb()` reopens. */
export async function closeDb(): Promise<void> {
  const pending = handlePromise;
  handlePromise = undefined;
  if (!pending) return;
  try {
    const handle = await pending;
    await handle.close();
  } catch {
    // A handle that failed to open has nothing to close.
  }
}

function getHandle(): Promise<DbHandle> {
  if (!handlePromise) {
    handlePromise = open().catch((error: unknown) => {
      // Let the next caller try again rather than caching the failure forever.
      handlePromise = undefined;
      throw error;
    });
  }
  return handlePromise;
}

async function open(): Promise<DbHandle> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const handle = databaseUrl
    ? openNodePg(databaseUrl)
    : await openPglite(process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR);

  const migrate = shouldAutoMigrate(handle.driver, {
    DB_AUTO_MIGRATE: process.env.DB_AUTO_MIGRATE,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (migrate) {
    handle.appliedOnOpen = await migrateOrClose(handle);
  }
  log.info(
    {
      driver: handle.driver,
      location: handle.location,
      migrationsChecked: migrate,
      migrationsApplied: handle.appliedOnOpen,
    },
    migrate ? "database ready, migrations checked" : "database ready, migrations not checked",
  );
  return handle;
}

/**
 * Migrates a freshly opened handle and returns how many migrations it applied.
 * On failure the handle is released first, so a retry never leaks a pool.
 */
async function migrateOrClose(handle: DbHandle): Promise<number> {
  try {
    return await applyMigrations(handle.db);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openNodePg(connectionString: string): DbHandle {
  const host = hostOf(connectionString);
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
    ssl: tlsOptionFor(connectionString),
  });
  pool.on("error", (error) => log.error({ err: error }, "idle database connection failed"));

  if (process.env.VERCEL) {
    attachDatabasePool(pool);
    if (!isPooledNeonHost(host)) {
      log.warn(
        { host },
        "DATABASE_URL is not a pooled Neon endpoint (host lacks '-pooler'); " +
          "the free plan runs out of connections under a burst of judge submissions",
      );
    }
  }

  const db: Db = drizzleNodePg(pool, { schema });
  return { db, driver: "pg", location: host, appliedOnOpen: 0, close: () => pool.end() };
}

async function openPglite(dir: string): Promise<DbHandle> {
  // PGlite does not create parent directories, so a fresh checkout with
  // PGLITE_DIR=./data/pglite (data/ is gitignored) would fail to open.
  if (dir !== ":memory:") mkdirSync(dir, { recursive: true });
  const client = dir === ":memory:" ? new PGlite() : new PGlite(dir);
  await client.waitReady;
  const db: Db = drizzlePglite(client, { schema });
  return { db, driver: "pglite", location: dir, appliedOnOpen: 0, close: () => client.close() };
}
