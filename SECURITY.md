# Security policy

Dais holds student names, scores and feedback. Report a weakness privately; use invented data when demonstrating it.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/seanellul/dais/security/advisories/new). Private reporting is enabled on the repository. If that form is unavailable, contact [the maintainer](https://github.com/seanellul) to request a private reporting channel. Do not put exploit details, credentials or student data in public issues or comments.

Include the affected version or commit, route, reproduction steps, expected impact and any request ID. Remove cookies, judge card tokens, invite links, database connection strings, names and scores from attachments. Report an exposed credential without copying it into the report.

Test only a local instance or a deployment you are authorised to assess. A public demo invitation is not permission to stress the host or attack other visitors. The maintainer will review confirmed reports and coordinate a fix and disclosure; response times are not guaranteed during the preview.

## Supported versions

`main` is an unreleased preview. There are no supported stable releases until the first release gate is completed and tagged. Run an approved release for real events and review subsequent security updates.

## Implemented protections

- Organiser passwords use scrypt; failed sign-in and existing-account invite password checks consume durable account and trusted-IP attempt budgets.
- Session cookies are httpOnly and use secure transport in production. The database stores peppered token hashes. Organiser sessions and judge access can be revoked.
- A judge card is reusable until access is revoked; it is a secret, not a one-time token. **Sign out all devices** revokes that judge’s sessions and rotates their card. Device heartbeats do not establish a safe per-device revocation association.
- Invite claims are expiring and single use. Membership, claim and session changes occur atomically.
- Organiser queries and judge APIs enforce tenant and ownership checks. Mutations validate inputs and origin; request limits restrict attempts and payloads.
- Static judge pages use a hash-based CSP; dynamic organiser/auth pages use a nonce. Security headers also restrict framing and referrer disclosure.
- Errors return safe messages and request IDs. Logs redact common secret fields; developers must still avoid logging secrets.
- Competing submissions retain version and receipt history for an audited organiser decision.

These protections do not make a preview a completed security audit. Keep hosting accounts protected, restrict database access, review dependencies and retain backups. Phone storage contains private drafts: use trusted devices, avoid clearing browser data before receiving sheets, and sign out after the event. See [OFFLINE](docs/OFFLINE.md).

## Deployment release gates

Before public release, enable private vulnerability reporting, verify the deployed HTTPS origin and CSP, complete source/secret scanning, and test revocation and recovery. Do not publish real tournament data through demo fixtures, screenshots or issue reports.
