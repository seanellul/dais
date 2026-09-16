## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The tournament-day problem or the rule this serves. -->

## Checks

- [ ] `pnpm check` passes (lint, typecheck, unit tests)
- [ ] Integration tests pass if I touched `src/server` (`pnpm test:integration`)
- [ ] No real names of debaters, judges or schools, and no real scores, anywhere in the diff
- [ ] User-facing text uses the tournament vocabulary in `docs/GLOSSARY.md` (sheet, draw, two versions, set aside, publish results)
- [ ] Every organiser override I added asks for a reason and writes an audit row
- [ ] If I edited `src/server/db/schema.ts`, I ran `pnpm db:generate` and committed the migration
- [ ] `src/domain` still imports nothing from Next, React, Drizzle, pg or Node
- [ ] Docs updated where behaviour changed

## Screenshots

<!-- For UI changes: light and dark, and the judge app at 390 px if relevant. Demo data only. -->
