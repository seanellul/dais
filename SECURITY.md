# Security policy

Dais handles the names of school students and their scores. Please treat any weakness that could expose them as serious, and report it privately.

## Reporting a vulnerability

Email **security@example.org** (placeholder: replace with the maintainer's address before the first public release), or use GitHub's private vulnerability reporting on this repository if it is enabled.

Please include:

- what you found and where (URL, route, file),
- steps to reproduce, with invented data only,
- the impact as you understand it.

You will get an acknowledgement within 5 working days and a fix or a plan within 30 days for confirmed problems. We will credit you in the release notes unless you prefer not to be named. Please give us time to fix the problem before you talk about it publicly.

Do not test against a tournament you do not run. The public demo at the hosted instance is fair game as long as you do not disrupt other visitors.

## Supported versions

| Version        | Supported                    |
| -------------- | ---------------------------- |
| `main`         | yes                          |
| latest `v1.x`  | yes, once `v1.0.0` is tagged |
| anything older | no                           |

## What Dais does to protect data

- Sessions are httpOnly cookies backed by a `sessions` table that stores a hash of the token; sessions can be revoked per person and per judge device.
- Organiser passwords are hashed with scrypt. Judge join links carry a one-time token; the short code is rate limited.
- Every response carries a Content-Security-Policy and the usual hardening headers (`src/proxy.ts`).
- Errors never include stack traces. Logs redact cookies, tokens and passwords.
- Nothing is deleted silently; every override is audited with a reason.
- CI runs gitleaks on every push. The repository must never contain real names or scores.

## Out of scope

- Denial of service against the free-tier hosting.
- Reports that need a compromised organiser account or device.
- The demo tournament's data, which is public and reset regularly.
