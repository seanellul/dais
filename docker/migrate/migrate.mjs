/**
 * Applies the SQL migrations under drizzle/ at container boot.
 *
 * Plain JavaScript on purpose: the image has no TypeScript runner. It reads
 * the same variables as the app (DATABASE_URL, PGLITE_DIR) and uses drizzle's
 * own migrator, so it applies exactly what `pnpm db:migrate` applies.
 *
 *   DATABASE_URL set   -> Postgres via `pg`
 *   DATABASE_URL unset -> embedded PGlite in PGLITE_DIR (default /data/pglite)
 *
 * Exit code 0 means every migration is applied. Any failure exits 1 so the
 * entrypoint can retry (Postgres still starting) or refuse to boot.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const migrationsFolder = process.env.MIGRATIONS_DIR ?? "/app/drizzle";
const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
const pgliteDir = (process.env.PGLITE_DIR ?? "/data/pglite").trim();

function log(message) {
  console.log(`[dais migrate] ${message}`);
}

async function migratePostgres() {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function migratePglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const client = new PGlite(pgliteDir);
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.close();
  }
}

async function main() {
  const journal = path.join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journal)) {
    log(`No migrations found at ${migrationsFolder}. Nothing to do.`);
    return;
  }

  if (databaseUrl) {
    log("Target: Postgres (DATABASE_URL).");
    await migratePostgres();
  } else {
    log(`Target: PGlite at ${pgliteDir}.`);
    await migratePglite();
  }
  log("Done.");
}

main().catch((error) => {
  // Print the message, never the connection string.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dais migrate] Failed: ${message}`);
  process.exit(1);
});
