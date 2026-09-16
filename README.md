# Dais

Points-ranked school debate tournaments, scored on phones. Organisers prepare teams, judges and rooms, publish the draw, receive sheets, resolve competing versions and publish results with a readable scoring trace.

MIT licensed. The repository is [seanellul/dais](https://github.com/seanellul/dais).

## Status

**Pre-release preview.** The review deployment is [dais-beryl.vercel.app](https://dais-beryl.vercel.app). Do not treat a preview or a successful automated test as approval to run a real event. Real-phone HTTPS/offline testing, a clean-clone start, hosted cold-start checks and opening the workbook in desktop Excel are release gates. No real-device testing is claimed here.

The default scoring policy follows the director’s workbook interpretation; organisers must confirm their tournament’s rules. Read [SCORING](docs/SCORING.md) and [open rule decisions](docs/QUESTIONS-FOR-IAN.md).

## Five-minute local start

Node 22 or newer, pnpm 11 (the exact version is pinned in `package.json`); `.nvmrc` selects Node 24.

```sh
git clone https://github.com/seanellul/dais.git
cd dais
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:3000>. With `DATABASE_URL` unset, Dais uses PGlite in `./data/pglite`; no separate database or Docker is required. Keep that directory: it contains your tournaments.

Choose **Try the live demo** for an isolated, expiring tournament with invented teams, judges, rooms, a published draw and half of round 1 received. Demo controls can simulate the rest of the day or reset it. Demo data expires after 24 hours; use first-owner setup at `/setup` and create a live tournament for persistent work. Demos do not prevent first-owner setup.

A phone cannot reach your laptop through `localhost`. Phone QR cards need a reachable `APP_URL`. Plain LAN HTTP does **not** support service workers on phones, so it cannot provide the offline judge app. See [OFFLINE](docs/OFFLINE.md).

## Tournament workflow

1. Create a tournament and follow its eight-step run sheet.
2. Add or paste teams, add judges, assign fixed room panels and check capacity.
3. Generate and review the seeded draw; resolve blockers and publish it. Print room doors, itineraries and judge cards.
4. Open each round. Judges score four debaters on their phones; the live board refreshes every five seconds. A phone’s saved draft or waiting state is different from a server receipt.
5. Enter paper sheets, receive a full phone hand-off, compare two versions, correct a sheet or waive a missing sheet with a recorded reason. A changed draw retains old sheets for explicit recovery.
6. Review result traces and any keep/set-aside overrides. Resolve completeness blockers, confirm the two finalists (including a reason for a tie decision), then publish. Reopen with a reason to make corrections.
7. Download records and a JSON backup. Sign out all devices for each judge after the day.

Scores use three categories out of 33, points of information out of 4 and an independent Overall out of 103. Overall is not automatically the category sum. Feedback has “What went well” and “Even better if”. Withdrawn or discarded scoring work remains in history; demo expiry, resets and explicitly authorised restore operations have their own lifecycle.

**Exports:** six CSVs (draw, itineraries, debaters, teams, scores and feedback), the XLSX workbook, a JSON backup and PDF/print versions of doors, itineraries, judge cards, blank scoresheets, feedback and results. Public pages expose only the schedule and allowed results, when enabled in settings. Use the generated public link; it includes the tournament ID.

**Hand-off:** send the full checked text or QR contents. The six-digit checksum only helps check that full payload; it cannot reconstruct a sheet. Matching later phone numbers can be settled by merging the original comments, with an organiser decision. See [OFFLINE](docs/OFFLINE.md).

## Development checks

| Command                                       | Purpose                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check`                                  | Lint, typecheck and unit tests                                                                   |
| `pnpm test:integration`                       | Service/API tests on isolated PGlite; set `DATABASE_URL_TEST` for a disposable Postgres database |
| `pnpm build`                                  | Production build, judge service worker and static CSP hashes                                     |
| `pnpm e2e`                                    | Playwright against `pnpm start`; build first                                                     |
| `E2E_BASE_URL=http://localhost:3000 pnpm e2e` | Use an already running production server                                                         |
| `pnpm venue`                                  | Laptop LAN fallback on PGlite, with a terminal QR and HTTP limitation notice                     |
| `pnpm db:generate`                            | Generate SQL and metadata after a schema change                                                  |
| `pnpm db:migrate`                             | Apply migrations to the configured database                                                      |

Install Chromium once with `pnpm exec playwright install chromium`. Tests use invented data. Integration tests must never target a live tournament database. See [CONTRIBUTING](CONTRIBUTING.md).

## Deploy to Vercel and Postgres

Neon is one supported Postgres provider. Plan limits and hosting terms change; check them before choosing an event deployment. This preview does not promise a cost or capacity guarantee.

1. Create the database near the app region (`iad1` in `vercel.json`). Use the pooled Neon connection for application traffic and the direct connection for migrations.
2. Import the repository into Vercel. Set `DATABASE_URL`, `APP_URL` (the public HTTPS origin), a random `SESSION_SECRET` and `CRON_SECRET`; choose `DEMO_ENABLED=1` or `0`. `.env.example` describes optional settings. Never deploy its example secrets. Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. Apply committed migrations with `pnpm db:migrate`, or configure the GitHub production environment and `DATABASE_URL_PRODUCTION` secret for `.github/workflows/migrate-production.yml`. Preview builds do not migrate production.
4. Git-triggered Vercel deploys and GitHub migrations may start concurrently. Use backward-compatible migrations, or arrange a migration-first deployment: disable automatic production Git builds and set the `VERCEL_DEPLOY_HOOK_URL` secret so the workflow calls a hook after migrations. Verify the hook and ignored-build behaviour on the first deployment.
5. Verify `/api/health`, `/api/health/db`, native demo entry, a judge QR on a real phone, offline recovery and exports on the deployed origin before the event.

Rotating `SESSION_SECRET` invalidates existing sessions and judge cards. Do it between events and reissue cards. Never commit credentials or real tournament data.

For event-day database warming, set repository variables `KEEPALIVE=1` and `APP_URL` to the deployed HTTPS origin; `.github/workflows/keepalive.yml` requests `/api/health/db` about every five minutes. Scheduled Actions can be delayed or disabled: this is a helper, not an availability guarantee. Keeping a round’s polling live board open also creates database traffic. Set `KEEPALIVE=0` after the event.

## Self-host

```sh
cp .env.example .env
# Replace example secrets and set a reachable APP_URL.
docker compose up -d
```

For the included Postgres configuration:

```sh
docker compose -f docker-compose.yml -f docker/compose.postgres.yml up -d
```

The image applies migrations at boot, runs the standalone server as an unprivileged user, and stores embedded data on a named volume. `SKIP_MIGRATIONS=1` delegates migrations to another operator. Use `sslmode=disable` explicitly for a trusted local Postgres without TLS; other configured modes use verified TLS. Back up the embedded volume while the app is stopped, or download per-tournament JSON backups.

For a laptop LAN rehearsal, run `pnpm venue`. It selects a LAN IPv4 address, binds Next development mode to `0.0.0.0`, uses a separate embedded database in `./data/venue`, and prints a judge sign-in QR. Set `VENUE_ADDRESS` if it selects the wrong interface, or `PORT` to choose a port. Create or restore the intended tournament in this database before relying on it. Keep the laptop and network running. This is an online browser fallback on a trusted LAN; plain HTTP on phones cannot run its service worker, and offline phone caching requires trusted HTTPS.

## Documentation

- [DAY-OF](docs/DAY-OF.md): rehearsal and event runbook
- [OFFLINE](docs/OFFLINE.md): phone storage, receipts, retry and hand-off limits
- [SCORING](docs/SCORING.md): policy and workbook equivalence
- [RULES-MAPPING](docs/RULES-MAPPING.md) and [QUESTIONS-FOR-IAN](docs/QUESTIONS-FOR-IAN.md): rules and decisions
- [HANDOVER](docs/HANDOVER.md): transferring hosting and backups
- [DESIGN](docs/DESIGN.md) and [GLOSSARY](docs/GLOSSARY.md): design and vocabulary
- [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)

## Licence

[MIT](LICENSE). Dais is not affiliated with a tournament or sponsor.
