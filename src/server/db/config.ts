/**
 * Decisions the database layer makes from its configuration, kept pure so
 * they can be unit-tested without opening a connection.
 *
 * Nothing here reads `process.env`; callers pass the values in.
 */

export type DbDriver = "pg" | "pglite";

/** The `ssl` option handed to `pg.Pool`. */
export type TlsOption = false | { rejectUnauthorized: boolean };

/** The environment variables that decide whether the app migrates itself. */
export interface AutoMigrateEnv {
  DB_AUTO_MIGRATE?: string;
  VERCEL_ENV?: string;
}

/** Which driver a `DATABASE_URL` value selects: any non-blank value means Postgres. */
export function driverFor(databaseUrl: string | undefined): DbDriver {
  return databaseUrl && databaseUrl.trim() !== "" ? "pg" : "pglite";
}

/**
 * TLS for a Postgres URL, decided by its `sslmode` alone (libpq's switch):
 *
 * - no `sslmode`, or `sslmode=disable`: plain TCP. This is the Docker Compose
 *   Postgres, a LAN server and CI's `localhost`. Neon refuses a plain
 *   connection with a clear error, so a Neon URL that lost its `sslmode`
 *   fails loudly rather than downgrading silently.
 * - `sslmode=no-verify`: TLS without certificate checks (`pg`'s own extension).
 * - any other mode (`require`, `verify-ca`, `verify-full`, `prefer`, `allow`):
 *   TLS with certificate verification. Neon's dashboard URLs carry
 *   `sslmode=require`.
 *
 * `pg` reads `sslmode` from the URL as well, and its reading takes precedence
 * over an explicit `ssl` option; the two agree for every mode above. Passing
 * the option explicitly matters when the URL says nothing: `pg` would then
 * consult `PGSSLMODE`, and this app wants the URL to be the whole story.
 */
export function tlsOptionFor(connectionString: string): TlsOption {
  const mode = sslModeOf(connectionString);
  if (mode === undefined || mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/** The `sslmode` query parameter of a URL, or undefined. Tolerates URLs `new URL` rejects. */
export function sslModeOf(connectionString: string): string | undefined {
  const match = /[?&]sslmode=([^&#]*)/.exec(connectionString);
  if (!match) return undefined;
  const mode = decodeURIComponent(match[1]).trim().toLowerCase();
  return mode === "" ? undefined : mode;
}

/** The host name of a connection string, or "" when it cannot be read. Never the password. */
export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    // `new URL` rejects some passwords `pg` accepts; fall back to the text after "@".
    const match = /@([^/:?#]+)/.exec(connectionString);
    return match?.[1] ?? "";
  }
}

/** True for Neon's pooled endpoint, the one a serverless deployment must use. */
export function isPooledNeonHost(host: string): boolean {
  return host.includes("-pooler");
}

/**
 * Whether `getDb()` applies pending migrations when it opens.
 *
 * - PGlite (local development, tests): yes, unless `DB_AUTO_MIGRATE=0`. There
 *   is nothing else that would migrate it.
 * - Postgres: only when `DB_AUTO_MIGRATE=1`, and never on a Vercel preview
 *   deployment, which may share `DATABASE_URL` with production. CI migrates
 *   production before the deploy and the Docker entrypoint migrates before the
 *   app starts, so the app itself normally never migrates Postgres.
 */
export function shouldAutoMigrate(driver: DbDriver, env: AutoMigrateEnv): boolean {
  if (env.DB_AUTO_MIGRATE === "0") return false;
  if (driver === "pglite") return true;
  return env.DB_AUTO_MIGRATE === "1" && env.VERCEL_ENV !== "preview";
}
