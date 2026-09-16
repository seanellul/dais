/**
 * Applies pending migrations from the command line: `pnpm db:migrate`.
 *
 * Loads `.env.local` first and then `.env` (a value in `.env.local` wins), the
 * same files `.env.example` tells developers to create. With `DATABASE_URL`
 * it migrates that Postgres database; without it, the embedded PGlite
 * database at `PGLITE_DIR` (default `./data/pglite`). The CI deploy job runs
 * this before the app deploys. It ignores `DB_AUTO_MIGRATE`: running it means
 * "migrate now".
 *
 * The target is printed before anything happens (a host name or a directory,
 * never the full URL) so an operator can see which database is about to change.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env.local", ".env"], quiet: true });

function describeTarget(hostOf: (url: string) => string): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return `Postgres at ${hostOf(databaseUrl) || "(unreadable host)"}`;
  return `PGlite in ${process.env.PGLITE_DIR ?? "./data/pglite"}`;
}

async function main(): Promise<void> {
  // Imported here, after dotenv has filled process.env, so the server's
  // validated env (parsed once, on first import) sees the same values.
  const { closeDb, migrateDb } = await import("../src/server/db/client");
  const { hostOf } = await import("../src/server/db/config");

  console.log(`Migrating ${describeTarget(hostOf)}...`);
  try {
    const report = await migrateDb();
    const noun = report.recorded === 1 ? "migration" : "migrations";
    console.log(`Done. Applied ${report.applied} now; ${report.recorded} ${noun} recorded.`);
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
