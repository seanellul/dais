/**
 * Applies the SQL migrations under `drizzle/` to a database.
 *
 * Both drivers use the same function: `applyMigrations(db)` works on a PGlite
 * database (local development, tests) and on a `pg` database (production).
 * `getDb()` in `./client` calls it on first use when the auto-migrate policy
 * allows, and `migrateDb()` (used by `pnpm db:migrate`) calls it always.
 *
 * How it runs
 * -----------
 * Everything happens in one transaction that first takes a transaction-scoped
 * advisory lock (`pg_advisory_xact_lock`). Two app instances that wake at the
 * same moment therefore migrate one after the other, and the lock disappears
 * with the commit. A transaction-scoped lock is the only kind that is safe
 * behind a connection pooler in transaction mode (Neon's `-pooler` endpoint,
 * PgBouncer): a session-level lock can stay on a server connection the client
 * no longer holds and block every later starter.
 *
 * The bookkeeping mirrors drizzle-orm's own migrator exactly: the same
 * `drizzle.__drizzle_migrations` table, the same `hash` and `created_at`
 * values, the same "apply everything newer than the last recorded row" rule.
 * Rows written here and rows written by `drizzle-kit migrate` or by the Docker
 * boot helper (`docker/migrate/migrate.mjs`) are interchangeable. Drizzle's
 * migrator is not called directly because it opens its own transaction, which
 * cannot be nested inside the one that holds the lock.
 *
 * Where the migrations folder is found
 * ------------------------------------
 * The folder is looked up at run time in this order and the first candidate
 * that contains `meta/_journal.json` wins:
 *
 * 1. `DAIS_MIGRATIONS_DIR`, when set.
 * 2. `<current working directory>/drizzle`. This covers `pnpm dev`, vitest,
 *    `pnpm db:migrate` and the Docker image, whose entrypoint runs from the
 *    standalone folder with `drizzle/` copied next to `server.js`.
 * 3. `<this file>/../../../drizzle`, the source layout, for any runner that
 *    starts from another directory but imports this module unbundled.
 *
 * Next.js `output: 'standalone'` copies only traced files, so a deployment
 * that migrates at run time must copy `drizzle/` into the standalone folder
 * (the Dockerfile does) or add it to `outputFileTracingIncludes`. A Vercel
 * deployment does neither, which is one reason the app does not migrate
 * Postgres by itself (see `shouldAutoMigrate` in `./config`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** A Drizzle Postgres database of either driver, with or without a schema. */
export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Postgres advisory lock key; `hashtext()` turns it into the integer the lock needs. */
const MIGRATION_LOCK_KEY = "dais:migrate";

/** Both drivers return an object with `rows`; the shared Drizzle type does not say so. */
interface RowsResult<Row> {
  rows: Row[];
}

/** Returns the absolute path of the migrations folder. Throws when none is found. */
export function resolveMigrationsFolder(): string {
  const candidates = [
    process.env.DAIS_MIGRATIONS_DIR,
    path.join(process.cwd(), "drizzle"),
    sourceRelativeMigrationsFolder(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `Migrations folder not found. Looked in: ${candidates.join(", ")}. ` +
      "Set DAIS_MIGRATIONS_DIR or run from the repository root.",
  );
}

/** The `drizzle/` folder relative to this source file, when the runtime exposes a file URL. */
function sourceRelativeMigrationsFolder(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "..", "..", "drizzle");
  } catch {
    return undefined;
  }
}

/**
 * Applies every migration that is newer than the last one recorded, inside
 * one locked transaction. Running it twice is safe: the second run finds
 * nothing to do. Returns how many migrations it applied this time.
 */
export async function applyMigrations(
  db: AnyPgDatabase,
  migrationsFolder: string = resolveMigrationsFolder(),
): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder });

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))`);
    await ensureMigrationsTable(tx);

    const lastApplied = await lastAppliedMillis(tx);
    let applied = 0;
    for (const migration of migrations) {
      if (lastApplied !== undefined && lastApplied >= migration.folderMillis) continue;
      await applyOne(tx, migration);
      applied += 1;
    }
    return applied;
  });
}

/** The table drizzle-orm keeps its record in. `IF NOT EXISTS` keeps it idempotent. */
async function ensureMigrationsTable(db: AnyPgDatabase): Promise<void> {
  await db.execute(sql`create schema if not exists drizzle`);
  await db.execute(sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
}

/** `created_at` of the newest recorded migration (its journal timestamp), or undefined. */
async function lastAppliedMillis(db: AnyPgDatabase): Promise<number | undefined> {
  const result = (await db.execute(
    sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  )) as RowsResult<{ created_at: string | number | null }>;
  const value = result.rows[0]?.created_at;
  return value === null || value === undefined ? undefined : Number(value);
}

/** Runs one migration's statements and records it, exactly as drizzle-orm would. */
async function applyOne(db: AnyPgDatabase, migration: MigrationMeta): Promise<void> {
  for (const statement of migration.sql) {
    await db.execute(sql.raw(statement));
  }
  await db.execute(
    sql`insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${migration.hash}, ${migration.folderMillis})`,
  );
}

/** Counts the migration rows recorded so far, for logs and the CLI. */
export async function countAppliedMigrations(db: AnyPgDatabase): Promise<number> {
  const result = (await db.execute(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  )) as RowsResult<{ count: string | number }>;
  return Number(result.rows[0]?.count ?? 0);
}
