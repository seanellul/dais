# Dais

[![CI](https://github.com/OWNER/dais/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dais/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)](#status)

Dais runs points-ranked school debate tournaments. Judges score on their phones, and the sheets keep working when the venue Wi-Fi does not. The organiser watches every sheet arrive on one board, sets aside outliers with a reason, publishes results, and exports the director's workbook. It is free and open source under the MIT licence, and a whole tournament fits inside the free tiers of Vercel and Neon, or one Docker container on a laptop.

> **Status.** Dais is being built for its first deployment, a two-division inter-schools tournament in the Cayman Islands. Until the `v1.0.0` tag exists, treat every screen as a preview and every setting as subject to change.

## Five-minute local start

You need Node 22 or newer (24 recommended, see `.nvmrc`) and pnpm. No database, no Docker.

```sh
git clone https://github.com/OWNER/dais.git
cd dais
corepack enable        # installs the pinned pnpm on first use
pnpm install
pnpm dev
```

Open <http://localhost:3000>. With no `DATABASE_URL`, Dais stores everything in an embedded PGlite database under `./data/pglite`. Click **Try the live demo** to get a tournament that is about to start: teams, judges, rooms and a published draw. Scan the judge QR code with a phone on the same network to score a room.

Useful commands:

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm check`            | lint, typecheck and unit tests, the same gate CI runs first         |
| `pnpm test:integration` | the database suite on PGlite (set `DATABASE_URL_TEST` for Postgres) |
| `pnpm e2e`              | Playwright against a production build                               |
| `pnpm db:generate`      | write a migration after editing `src/server/db/schema.ts`           |
| `pnpm db:migrate`       | apply migrations to `DATABASE_URL`                                  |

## What Dais does

**Before the day.** Paste the team list in the shape of the director's spreadsheet (school, debater, team). Add judges; each gets a short code and a QR card. Set up rooms and panels. Draw the rounds at random by team code with a visible seed, so anyone with the seed and the team list can reproduce the draw. Check the draw against the rules (nobody meets twice, sides balanced, every judge in one room per round). Print door sheets, itineraries and judge cards.

**During rounds.** Judges open the app once online, then score in speaking order on a 390 px screen: three categories out of 33, points of information out of 4, an independent Overall out of 103 with the rubric band shown as they type, and "What went well" / "Even better if" for each debater. Every change is saved on the phone. Sheets send when there is signal and wait when there is not. The organiser's live board shows each room and judge seat: not yet in, in, waiting on the phone, two versions, the draw changed. Sheets can be typed in from paper, corrected with a reason, or handed off by QR code when a phone will not connect.

**Results.** The tournament's outlier policy runs exactly as the director's workbook does: pooled average and spread per debater, scores outside the kept range set aside, round averages summed, ranks with ties preserved. Every set-aside score names the judge and the range, in words. The organiser can keep or set aside any score with a reason; every override is audited and reversible. Results stay provisional, with the missing sheets named, until they are published. Exports: the workbook in the director's shape with live formulas, five CSVs, per-school feedback packs, and a JSON backup.

**Reliability.** No sheet is ever silently lost or overwritten. Submissions are idempotent, conflicts are stored as data for the organiser to resolve, and nothing is deleted: withdrawn teams are flagged, discarded sheets become tombstones. Errors carry a request id you can quote.

## Deploy to Vercel + Neon

Both free tiers are enough for a one-day tournament with 40 teams and 20 judges.

1. **Neon.** Create a project in an AWS `us-east-1` region (next to Vercel's `iad1`). Copy two connection strings: the **pooled** one (its host contains `-pooler`) and the direct one.
2. **Vercel.** Import the repository. `vercel.json` pins the `iad1` region, adds the daily cleanup cron and sets no-cache headers on the service worker.
3. **Environment variables** in the Vercel project (see `.env.example`):
   - `DATABASE_URL`: the **pooled** Neon string. The direct endpoint exhausts the free-plan connection budget under a burst of judge submissions.
   - `SESSION_SECRET`: 32 random bytes, base64. Rotating it signs everyone out.
   - `CRON_SECRET`: protects `/api/cron/*`. Vercel sends it with cron requests.
   - `APP_URL`: the public origin, used in QR codes and join links.
   - `DEMO_ENABLED`: `1` to expose the public demo, `0` to hide it.
4. **Migrations.** Add the GitHub secret `DATABASE_URL_PRODUCTION` (the **direct** Neon string). The workflow `.github/workflows/migrate-production.yml` applies `drizzle/*.sql` on every push to `main`. Migrations never run from Vercel's build command, because preview builds would migrate production.
5. **Deploy ordering.** With Vercel's Git integration the production build starts at the same moment as the migration workflow. Two ways to handle this:
   - _Simple:_ keep Git deploys and write backward-compatible migrations (add columns before code reads them, drop them one release later). This is the default.
   - _Strict:_ in Vercel, set **Settings → Git → Ignored Build Step** to `if [ "$VERCEL_ENV" = "production" ]; then exit 0; else exit 1; fi` so production no longer builds on push, create a **Deploy Hook** for `main`, and store its URL in the GitHub secret `VERCEL_DEPLOY_HOOK_URL`. The workflow calls the hook only after the migration succeeds. Verify on the first deploy that hook-triggered builds are not skipped by the ignored build step.
6. **Tournament day.** Neon suspends an idle database after a few minutes. Keeping the organiser dashboard open keeps it awake (the live board polls). As a helper, set the repository variables `KEEPALIVE=1` and `APP_URL` to have `.github/workflows/keepalive.yml` ping `/api/health/db` every five minutes; set `KEEPALIVE=0` afterwards.

`GET /api/health` answers without the database; `GET /api/health/db` runs `SELECT 1`. Use them for uptime checks.

## Self-host with Docker

```sh
cp .env.example .env            # set SESSION_SECRET and APP_URL
docker compose up -d            # embedded PGlite database on a named volume
```

Or on Postgres:

```sh
docker compose -f docker-compose.yml -f docker/compose.postgres.yml up -d
```

The image (`Dockerfile`, multi-stage on `node:24-alpine`) runs Next's standalone server as an unprivileged user, applies migrations at boot through `docker/entrypoint.sh`, exposes port 3000, stores PGlite data on the `/data` volume and reports health at `/api/health` (`/api/health/db` also checks the database). Set `DATABASE_URL` to use any Postgres 15+ instead. For a Postgres without TLS, append `?sslmode=disable` to the URL; every other host gets verified TLS. Back up a PGlite deployment by copying the volume while the container is stopped, or by downloading the JSON backup from the tournament's settings page.

Two variables control migrations in the container. The entrypoint applies them once at boot and sets `DB_AUTO_MIGRATE=0` so the app does not apply them again on its first request. Set `SKIP_MIGRATIONS=1` when somebody else migrates the database; the container then never touches the schema.

For a venue with no internet at all, run the container (or `pnpm dev`) on a laptop and let judges' phones join the laptop's hotspot or the venue LAN; `docs/DAY-OF.md` covers this fallback.

## How Dais compares

Tabbycat is the standard for win-loss tabbing of British Parliamentary and similar formats, with power-pairing, adjudicator allocation and break rounds; it runs on Django and needs a server. Dais does one narrower thing: one-day, points-ranked schools tournaments with a rubric, feedback sheets and offline phone scoring, on a free tier or one container, with a director's-workbook export.

## Documentation

| Document                                               | Read it when                                         |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [docs/DAY-OF.md](docs/DAY-OF.md)                       | you are running a tournament                         |
| [docs/GLOSSARY.md](docs/GLOSSARY.md)                   | you write any text a judge or organiser will see     |
| [docs/RULES-MAPPING.md](docs/RULES-MAPPING.md)         | you want to know which setting implements which rule |
| [docs/QUESTIONS-FOR-IAN.md](docs/QUESTIONS-FOR-IAN.md) | you want the open decisions and the current defaults |
| [docs/HANDOVER.md](docs/HANDOVER.md)                   | a charity takes over the hosting                     |
| [CONTRIBUTING.md](CONTRIBUTING.md)                     | you want to change the code                          |
| [SECURITY.md](SECURITY.md)                             | you found a security problem                         |

Also planned: `docs/SCORING.md` (the outlier policy and how to reproduce the golden fixture in Excel), `docs/OFFLINE.md` (the judge app's state machine) and `docs/DESIGN.md` (tokens and themes).

## Licence

MIT. See [LICENSE](LICENSE). Dais is not affiliated with any tournament or sponsor; the first deployment's name appears only as that tournament's name.
