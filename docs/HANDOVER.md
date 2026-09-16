# Handover

How a charity or school league takes over a Dais deployment from the person who set it up, and how to run it without them. Written for a non-technical treasurer with one technical volunteer beside them. Nothing here needs a developer.

Dais is MIT licensed. The organisation owns its data. The hosting accounts can be transferred; if that is ever awkward, the self-host route at the end works from a JSON backup.

## What you are taking over

| Thing        | Where it lives           | What it holds                                                           |
| ------------ | ------------------------ | ----------------------------------------------------------------------- |
| The code     | GitHub repository        | Public. Anyone can fork it.                                             |
| The app      | Vercel project           | Builds and serves the app. Holds the environment variables.             |
| The database | Neon project             | Every tournament, sheet, score and history row.                         |
| The domain   | Your DNS provider        | The address judges scan. Points at Vercel.                              |
| Backups      | Downloads + Neon history | JSON backups per tournament; Neon's point-in-time history.              |
| Automations  | GitHub Actions           | Production migrations, keepalive pings. Need two secrets and variables. |

## Step 1: accounts

Create, in the organisation's name and with a shared mailbox the organisation controls:

1. A **GitHub** account (or organisation) for the volunteer.
2. A **Vercel** account. The Hobby plan is free for non-commercial use; check Vercel's current terms for charities.
3. A **Neon** account. The Free plan is enough for a one-day tournament; check the current limits on compute hours and history.

Turn on two-factor authentication on all three. Store the recovery codes with the treasurer.

## Step 2: transfer the Vercel project

In the current owner's Vercel dashboard: **Project → Settings → General → Transfer project**, choose the organisation's account or team. Vercel moves the deployments, domains and environment variables with the project. Confirm in the new account that **Settings → Environment Variables** still lists:

- `DATABASE_URL` (the pooled Neon string, host contains `-pooler`)
- `SESSION_SECRET`
- `CRON_SECRET`
- `APP_URL`
- `DEMO_ENABLED`
- `LOG_LEVEL` (optional)

Also reconnect **Settings → Git** to the organisation's fork of the repository, so pushes deploy.

## Step 3: transfer the Neon project

In the current owner's Neon console: **Project → Settings → Transfer project** to the organisation's account. The connection strings do not change, so the app keeps working. Afterwards, rotate the database password from the Neon console and update `DATABASE_URL` in Vercel and `DATABASE_URL_PRODUCTION` in GitHub, so the previous owner no longer holds a working credential.

## Step 4: rotate the secrets

On the day of the handover, in the new Vercel project:

- Generate a new `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). This signs every organiser and judge out; do it between tournaments.
- Generate a new `CRON_SECRET`.

Redeploy after changing variables (Vercel → Deployments → Redeploy).

## Step 5: the domain

At the DNS provider, the domain (or a subdomain such as `scores.example.org`) is a `CNAME` to `cname.vercel-dns.com`. Add the domain in the new Vercel project (**Settings → Domains**) and remove it from the old one. Vercel issues the certificate. Keep the DNS account in the organisation's name too.

Update `APP_URL` if the address changed. Judge QR cards embed it; reprint them.

## Step 6: GitHub

Fork or transfer the repository into the organisation's GitHub account. Then set:

- **Secrets:** `DATABASE_URL_PRODUCTION` (the direct, non-pooled Neon string) so migrations run on merge; optionally `VERCEL_DEPLOY_HOOK_URL`.
- **Variables:** `APP_URL`, and `KEEPALIVE` (`1` on tournament days, `0` otherwise).

Enable Dependabot alerts (**Settings → Security**).

## Step 7: backups

Three layers, in order of ease:

1. **JSON backup per tournament.** Tournament → Settings → Backup → Download. Do this after publishing results, and store the file in the organisation's drive. It restores into any Dais instance, including a laptop.
2. **Neon history.** Neon keeps a rolling window of database history on the free plan (hours, not days; check the current plan). It lets you undo a mistake made today.
3. **Exports.** The director's workbook (XLSX) and CSVs are complete records of the results.

## Step 8: running it without the original developer

- **Before a tournament:** log in, create the tournament, follow the dashboard checklist. Read `docs/DAY-OF.md`.
- **Updates:** merge Dependabot pull requests when CI is green. Release notes on GitHub say what changed.
- **Something is wrong:** every error shows a request id. Vercel → Project → Logs, search for it. Open a GitHub issue with the id and the steps; never paste names or scores.
- **Costs:** check current plan terms, usage limits and billing alerts; a free tier is not an event-day capacity guarantee.

## The self-host alternative

If the hosting accounts cannot be transferred, or you want everything on one machine:

1. Install Docker on a laptop or a small server.
2. Clone the repository. `cp .env.example .env`, set `SESSION_SECRET` and `APP_URL`.
3. `docker compose up -d`. The app runs at port 3000 on an embedded database stored in a Docker volume.
4. Restore the JSON backup from Tournament → Settings → Restore.
5. Judges' phones must reach the laptop: same Wi-Fi, or the laptop's hotspot. For offline phone caching, use trusted HTTPS with a certificate the phones accept. Plain LAN HTTP can serve an online browser page, but phones cannot run its service worker, whether or not they install a home-screen icon. See `docs/OFFLINE.md`.

Back up a self-hosted instance by stopping the container and copying the volume, or by downloading JSON backups.

## Checklist

- [ ] Vercel project transferred; variables present; Git reconnected
- [ ] Neon project transferred; password rotated; `DATABASE_URL` updated everywhere
- [ ] `SESSION_SECRET` and `CRON_SECRET` rotated
- [ ] Domain moved and `APP_URL` correct; judge cards reprinted
- [ ] GitHub secrets and variables set; Dependabot on
- [ ] Latest JSON backup downloaded and stored
- [ ] Two people in the organisation can log in to all three accounts
