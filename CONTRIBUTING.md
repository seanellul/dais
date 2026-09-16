# Contributing to Dais

Thank you. Dais is read by students, teachers and volunteers as much as by developers, so clarity matters more than cleverness. This page tells you how to set up, what the checks are, and the handful of rules the code base does not bend on.

## Set up

```sh
corepack enable
pnpm install
pnpm dev
```

Node 22 or newer; `.nvmrc` says 24. No separate database is needed: with `DATABASE_URL` unset the app uses an embedded PGlite database in `./data/pglite`. Copy `.env.example` to `.env.local` only if you want to change a default.

Next.js 16 differs from older versions (`proxy.ts` instead of `middleware.ts`, Turbopack by default, async request APIs, typed routes). When unsure about an API, read `node_modules/next/dist/docs/01-app/` rather than memory.

## Checks

| Command                 | Runs                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm check`            | `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit)                         |
| `pnpm test:integration` | `tests/integration` on PGlite; set `DATABASE_URL_TEST` to run on Postgres |
| `pnpm e2e`              | Playwright against `pnpm start` (build first)                             |
| `pnpm format`           | Prettier                                                                  |

CI runs lint and typecheck, then unit tests with coverage, then the integration suite twice (PGlite and `postgres:16`), then a build, Playwright, a Docker build with a health check, and a gitleaks scan. A pull request needs all of them green.

## Non-negotiables

These come from `CLAUDE.md`, which is the short version every tool and contributor reads.

1. **Confidential data never enters the repository.** No real names of debaters, judges or schools, and no real scores, in code, fixtures, screenshots, tests, docs or commit messages. Invent sample data. The director's workbook is referenced by its shape only.
2. **`src/domain` is pure TypeScript.** No imports from Next, React, Drizzle, `pg`, PGlite, Node built-ins or any app layer. ESLint enforces it. The same code runs in the browser, on the server and in tests.
3. **Never throw to the UI.** Server Actions return `{ ok: true, data } | { ok: false, error }`. Route handlers return `{ code, message, retryable, requestId }` on errors. Use `AppError` and the factories in `src/server/errors.ts`.
4. **Every organiser override needs a reason and an audit row.** Retain scoring history: withdrawn entities use status flags and unmatched-sheet decisions keep the original record. Demo expiry, resets and authorised restores have explicit lifecycle semantics.
5. **Judge routes are JSON route handlers under `/api/judge/*`** with stable URLs. The judge app never calls Server Actions.
6. **No dynamic `import()` inside `src/judge`.** Everything must be precached for offline use.
7. **User-facing text uses the tournament vocabulary** in `docs/GLOSSARY.md`: sheet, debater, draw, panel, two versions, set aside, publish results. Internal code may use technical names; UI copy may not. British spelling.

## Layout

```
src/domain/       pure logic: scoring, draw, schedule validation, assignment identity, rubric, sheet schema, import/export, sample data
src/server/       db (schema, client, migrations), auth, services (one transaction per operation), actions, exports, log/errors/env
src/app/          Next.js App Router: (marketing), (auth), (org), (judge)/j, api/
src/judge/        the offline-first judge app: client components, IndexedDB store, sync
src/components/ui shadcn components;  src/ui/  Dais components and tokens
tests/unit  tests/integration  tests/e2e  tests/fixtures
docs/
```

## Test pyramid

- **Unit** (`src/**/*.test.ts`, `tests/unit/**`): pure functions, no database, milliseconds. Most tests live here. Property tests with fast-check cover the draw and the scoring policy. Coverage must stay at or above 90 % for `src/domain` and `src/judge/store`.
- **Integration** (`tests/integration/**`): services and route handlers against a real database, PGlite locally and `postgres:16` in CI. One transaction per operation, real concurrency where it matters (parallel submits, reused request ids).
- **End-to-end** (`tests/e2e/**`): Playwright through the browser, including the judge app offline (`context.setOffline`) and an axe accessibility pass on every route in light and dark.

Write the test at the lowest level that can prove the behaviour.

## Conventions

- Small functions with a name that says what they do. A doc comment on every exported symbol.
- Errors are `AppError`s created by the factories in `src/server/errors.ts`; unknown errors become `internal` and are logged with their cause under the request id.
- Logs go through `requestLogger(requestId)` from `src/server/log.ts`. Never log cookies, tokens, passwords or join codes; the logger redacts the obvious fields but do not rely on it.
- Configuration is read through `getEnv()` from `src/server/env.ts`, never from `process.env` directly.
- Dates are ISO strings in UTC on the wire; the UI formats them.
- Prettier formats; ESLint lints. Do not argue with either in a pull request.

## Adding a migration

1. Edit `src/server/db/schema.ts`.
2. Run `pnpm db:generate`. drizzle-kit writes `drizzle/NNNN_name.sql` and updates `drizzle/meta/`.
3. Read the SQL. Make it backward compatible where you can: add before you remove, and remove one release later.
4. Run `pnpm db:migrate` locally, then the integration suite.
5. Commit the SQL and the meta files together with the schema change.

When production secrets are configured, `.github/workflows/migrate-production.yml` applies migrations on pushes to `main`. Deployment waits only when migration-first hook ordering is configured; otherwise Vercel Git deploys may start concurrently (see the README). The Docker image applies it at boot through `docker/migrate/migrate.mjs`, a plain JavaScript helper with its own `package.json`; keep the versions of `drizzle-orm`, `pg` and `@electric-sql/pglite` there in step with the root `package.json`.

## Pull requests

Keep them small and describe the tournament-day problem they solve. The pull request template has the checklist. Screenshots for UI changes: light and dark, and 390 px wide for the judge app, with demo data only.

## Reporting a security problem

Do not open a public issue. See `SECURITY.md`.

## Preview and release evidence

The intended repository is `https://github.com/seanellul/dais`; it is being prepared for release. Report automated Chromium evidence separately from a real-phone HTTPS/offline rehearsal, hosted Neon cold-start testing, a clean-clone start and desktop Excel checks. A phone-width screenshot is not a real-device test. Keep unfinished release gates visible.

For accessibility changes, test organiser/auth/print routes in light and dark, phone-width overflow and targets, keyboard navigation and main focus. Wait for theme hydration and CSS transitions before measuring static contrast. Judge offline checks require a production build and service worker; plain LAN HTTP on phones cannot provide them. Hand-off regressions must use full checked payloads, preserve receipts and demonstrate the original phone retry retaining comments.

Use a disposable `DATABASE_URL_TEST`. Avoid extra public demo creation in route scans; reuse an isolated fixture. Never commit browser storage-state files or traces containing credentials.
