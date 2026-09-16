@AGENTS.md

# Dais — working conventions

Dais is an open-source (MIT) app for points-ranked school debate tournaments: organisers run the day from a dashboard, judges score on their phones offline, results follow the tournament's outlier policy. First deployment: the Conyers Inter-Schools Debate Tournament (ESU Cayman).

## Non-negotiables

- **Confidential data never enters this repo.** No real student, judge or school names, no real scores. Sample data is invented. The director's workbook is referenced by shape only.
- **`src/domain` is pure TypeScript.** No imports from Next, React, Drizzle, pg, PGlite, Node built-ins or any app layer (ESLint enforces it). It runs in the browser, on the server and in tests. Hashing uses `@noble/hashes`.
- **Never throw to the UI.** Server Actions return `{ ok: true, data } | { ok: false, error }`. Route handlers return `{ code, message, retryable, requestId }` on errors.
- **Every organiser override needs a reason and an audit row.** Nothing is ever silently deleted: withdrawn entities are status flags, discarded judge sheets become tombstones.
- **Judge routes are JSON route handlers under `/api/judge/*`** with stable URLs; the judge PWA never calls Server Actions.
- **No dynamic `import()` inside `src/judge`** (everything must be precached for offline use).

## Vocabulary (en-GB)

Use plain tournament words in every user-facing string: sheet (not assignment), debater (not contestant/speaker, except for the speaking roles PM/LO/GM/OM), draw, panel, "received by the tournament", waiting to send, needs attention (never "blocked"), two versions (not conflict), the draw changed (not retired), set aside / kept (not lopped / excluded / retained), can't be scored yet (not unresolved), average / spread / kept range (not mean / SD / bounds), publish results / reopen (not finalize / unlock), type in from paper, correct scores, organiser, What went well / Even better if, Overall score (out of 103). Internal code may use technical names; UI copy may not.

## Layout

- `src/domain/` pure logic (scoring, draw, schedule validation, assignment identity, rubric, sheet schema, import/export, sample data).
- `src/server/` db (Drizzle schema, client, migrations runner), auth, services (one transaction per operation), actions (thin `'use server'` wrappers), export renderers, log/errors.
- `src/app/` Next.js App Router routes: `(marketing)`, `(auth)`, `(org)`, `(judge)/j`, `api/`.
- `src/judge/` the offline-first judge PWA (client components, IndexedDB store, sync).
- `src/components/ui/` shadcn components; `src/ui/` Dais components and tokens.
- `tests/unit`, `tests/integration`, `tests/e2e`, `tests/fixtures`.
- `docs/` SCORING, OFFLINE, DESIGN, GLOSSARY, HANDOVER, DAY-OF, RULES-MAPPING, QUESTIONS-FOR-IAN.

## Commands

`pnpm dev` (PGlite, no database needed) · `pnpm check` (lint + typecheck + unit) · `pnpm test:integration` · `pnpm e2e` · `pnpm db:generate` after editing `src/server/db/schema.ts` · `pnpm db:migrate`.

Next.js 16 differs from older versions (proxy.ts not middleware, Turbopack default, async request APIs). Read `node_modules/next/dist/docs/01-app/` before using an API you are unsure about.
