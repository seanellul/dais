#!/bin/sh
# Boots the Dais container: applies database migrations, then starts Next.
#
# Migrations run through docker/migrate/migrate.mjs, a plain JavaScript helper
# with its own node_modules, because the TypeScript runner (tsx) is a
# devDependency and is not part of Next's standalone output. The helper is
# idempotent: drizzle records applied migrations in __drizzle_migrations.
#
# When DATABASE_URL points at a Postgres that is still starting (docker
# compose), the helper is retried a few times before giving up.
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/app/drizzle}"
MIGRATE_ATTEMPTS="${MIGRATE_ATTEMPTS:-10}"
MIGRATE_RETRY_SECONDS="${MIGRATE_RETRY_SECONDS:-3}"

log() {
  printf '[dais] %s\n' "$*"
}

run_migrations() {
  attempt=1
  until MIGRATIONS_DIR="$MIGRATIONS_DIR" node /app/docker/migrate/migrate.mjs; do
    if [ "$attempt" -ge "$MIGRATE_ATTEMPTS" ]; then
      log "Migrations failed after $attempt attempts. Not starting the server."
      exit 1
    fi
    log "Migration attempt $attempt failed (database not ready?). Retrying in ${MIGRATE_RETRY_SECONDS}s."
    attempt=$((attempt + 1))
    sleep "$MIGRATE_RETRY_SECONDS"
  done
}

if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  log "SKIP_MIGRATIONS=1: not applying migrations."
elif [ -f "$MIGRATIONS_DIR/meta/_journal.json" ]; then
  if [ -n "${DATABASE_URL:-}" ]; then
    log "Applying migrations to Postgres."
  else
    log "Applying migrations to the embedded PGlite database in ${PGLITE_DIR:-/data/pglite}."
  fi
  run_migrations
  log "Migrations are up to date."
else
  log "No migrations found in $MIGRATIONS_DIR (no meta/_journal.json). Skipping."
fi

# The entrypoint owns migrations in this image. Tell the app not to run the
# migrator again on its first request, so SKIP_MIGRATIONS=1 really means "do
# not touch the schema" and a normal boot migrates once, not twice. An
# explicit DB_AUTO_MIGRATE in the environment still wins.
export DB_AUTO_MIGRATE="${DB_AUTO_MIGRATE:-0}"

log "Starting Dais on port ${PORT:-3000}."
exec node /app/server.js
