# syntax=docker/dockerfile:1.7
#
# Dais self-host image.
#
#   docker build -t dais --build-arg GIT_SHA=$(git rev-parse HEAD) .
#   docker run -d -p 3000:3000 -v dais-data:/data -e SESSION_SECRET=... dais
#
# GIT_SHA is optional; /api/health reports it as `version` (default "dev").
#
# With no DATABASE_URL the app runs on an embedded PGlite database stored on
# the /data volume. Set DATABASE_URL to use Postgres instead (see
# docker-compose.yml and docker/compose.postgres.yml). A Postgres without TLS
# needs `?sslmode=disable` on the URL; every other host gets verified TLS.
#
# Migrations: the entrypoint applies them once at boot and sets
# DB_AUTO_MIGRATE=0 so the app does not apply them again on its first
# request. SKIP_MIGRATIONS=1 turns the boot-time step off as well, for a
# database that somebody else migrates.
#
# Stages:
#   deps          install every dependency from the lockfile
#   build         `next build` with output: "standalone"
#   migrate-deps  the three packages the boot-time migration helper needs,
#                 from docker/migrate/package-lock.json
#   runtime       the small image that actually runs

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# corepack reads the "packageManager" field in package.json and fetches that
# exact pnpm version.
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build only prerenders pages; it needs no secrets. env.ts allows the
# development fallback for SESSION_SECRET while NEXT_PHASE is the build phase.
ENV NODE_ENV=production
RUN mkdir -p drizzle public && pnpm build

# ---------------------------------------------------------------------------
# tsx (which runs scripts/migrate.ts) is a devDependency and is not part of
# the standalone output, so the container migrates with a plain JavaScript
# helper (docker/migrate/migrate.mjs) that has its own small node_modules.
FROM node:${NODE_VERSION}-alpine AS migrate-deps
WORKDIR /migrate
COPY docker/migrate/package.json docker/migrate/package-lock.json ./
# `npm ci` installs exactly what the lockfile says, so two builds of the same
# commit get the same PGlite and drizzle versions as the app itself.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PGLITE_DIR=/data/pglite
# The commit this image was built from; /api/health reports it as `version`.
ARG GIT_SHA=dev
ENV DAIS_VERSION=$GIT_SHA
WORKDIR /app

# The PGlite volume. Owned by the unprivileged "node" user the image runs as.
RUN mkdir -p /data && chown node:node /data

# Next's standalone server plus the two folders it does not copy by itself.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# SQL migrations and the helper that applies them at boot.
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=migrate-deps --chown=node:node /migrate/node_modules ./docker/migrate/node_modules
COPY --chown=node:node docker/migrate/package.json docker/migrate/migrate.mjs ./docker/migrate/
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

USER node
VOLUME /data
EXPOSE 3000

# /api/health answers without touching the database, so a sleeping or broken
# database shows up in /api/health/db and the logs, not as a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["./docker/entrypoint.sh"]
