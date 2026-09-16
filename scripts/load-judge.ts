/** Bounded, fictional-only real HTTP/PG check. Never prints credentials.
 * Setup: DAIS_LOAD_SETUP=1 DATABASE_URL=... SESSION_SECRET=... APP_URL=... tsx scripts/load-judge.ts --setup
 * Run: DAIS_LOAD_FIXTURE=data/load-fixture-local.json DAIS_LOAD_BASE_URL=http://... tsx scripts/load-judge.ts
 * Setup creates one fresh expiring demo; running only submits assignments in that named fixture.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "dotenv";
import type { JudgeBootstrap } from "../src/judge/api-types";
import type { SheetPayload } from "../src/domain/types";
config({ path: [".env.local", ".env"], quiet: true });
export const loadFixtureSchema = z.object({
  fictional: z.literal(true),
  tournamentId: z.uuid(),
  name: z.string().startsWith("Dais load check "),
  slug: z.string(),
  tournamentCode: z.string(),
  ownerSession: z.string(),
  judges: z.array(z.object({ id: z.uuid(), code: z.string() })).length(30),
});
export type LoadFixture = z.infer<typeof loadFixtureSchema>;
const fixturePath = process.env.DAIS_LOAD_FIXTURE ?? "data/load-fixture-local.json";
async function setup() {
  if (process.env.DAIS_LOAD_SETUP !== "1" || !process.env.DATABASE_URL)
    throw new Error("setup_guard");
  try {
    await access(fixturePath);
    throw new Error("fixture_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  process.env.LOG_LEVEL = "silent";
  const { getDb, closeDb } = await import("../src/server/db");
  const { createContext, SYSTEM_ACTOR } = await import("../src/server/services/context");
  const { createDemoTournament } = await import("../src/server/services/demo");
  const { loadGraph } = await import("../src/server/services/graph");
  const { openRound } = await import("../src/server/services/rounds");
  const { createUserSession } = await import("../src/server/auth/session");
  const db = await getDb();
  try {
    const ctx = createContext({ db, actor: SYSTEM_ACTOR });
    const name = `Dais load check ${randomUUID()}`;
    const created = await createDemoTournament(ctx, {
      kind: "demo",
      name,
      stage: "drawn",
      seed: randomUUID(),
    });
    if (!created.userId) throw new Error("fixture_owner");
    for (const number of [1, 2, 3])
      await db.transaction((tx) => openRound(tx, ctx, created.tournamentId, number));
    const graph = await loadGraph(db, created.tournamentId);
    const owner = await createUserSession(db, ctx, created.userId);
    const fixture = loadFixtureSchema.parse({
      fictional: true,
      tournamentId: created.tournamentId,
      name,
      slug: created.slug,
      tournamentCode: created.joinCode,
      ownerSession: owner.token,
      judges: graph.judges.map((j) => ({ id: j.id, code: j.code })),
    });
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600, flag: "wx" });
    console.log(
      JSON.stringify({
        setup: "created",
        judges: fixture.judges.length,
        expires: "24h",
        fixturePath,
      }),
    );
  } finally {
    await closeDb();
  }
}
export function loadPayload(bootstrap: JudgeBootstrap, assignmentId: string): SheetPayload {
  const row = bootstrap.assignments.find((row) => row.id === assignmentId);
  if (!row) throw new Error("assignment");
  const rubric = bootstrap.tournament.rubric;
  return {
    sideFlipped: false,
    roleSwaps: {},
    scores: Object.fromEntries(
      row.identity.speakers.map((speaker) => [
        speaker.id,
        {
          argumentation: Math.floor(
            (rubric.categories.find((c) => c.key === "argumentation")?.max ?? 33) * 0.75,
          ),
          rebuttal: Math.floor(
            (rubric.categories.find((c) => c.key === "rebuttal")?.max ?? 33) * 0.75,
          ),
          presentation: Math.floor(
            (rubric.categories.find((c) => c.key === "presentation")?.max ?? 33) * 0.75,
          ),
          poi: Math.min(3, rubric.categories.find((c) => c.key === "poi")?.max ?? 4),
          overall: Math.min(78, rubric.overallMax),
          www: "Fictional load check",
          ebi: "Fictional feedback",
        },
      ]),
    ),
  };
}
async function run() {
  const fixture = loadFixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
  const base = new URL(
    process.env.DAIS_LOAD_BASE_URL ?? process.env.APP_URL ?? "http://127.0.0.1:4318",
  );
  const origin = base.origin;
  const prepared = await Promise.all(
    fixture.judges.map(async (judge) => {
      const response = await fetch(new URL("/api/judge/login", base), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ tournamentCode: fixture.tournamentCode, judgeCode: judge.code }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`login_${response.status}`);
      const cookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith("dais.judge="))
        ?.split(";")[0];
      if (!cookie) throw new Error("cookie");
      const me = await fetch(new URL("/api/judge/me", base), {
        headers: { Cookie: cookie },
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (!me.ok) throw new Error(`bootstrap_${me.status}`);
      const { data } = (await me.json()) as { data: JudgeBootstrap };
      if (
        data.tournament.id !== fixture.tournamentId ||
        data.tournament.name !== fixture.name ||
        data.judge.id !== judge.id
      )
        throw new Error("fixture_identity");
      const assignment = data.assignments.find(
        (row) =>
          !row.retiredAt && row.identity.round === 2 && !row.current && row.roundStatus === "open",
      );
      if (!assignment) throw new Error("fixture_not_fresh");
      return {
        cookie,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        baseVersion: 0,
        payload: loadPayload(data, assignment.id),
      };
    }),
  );
  const started = performance.now();
  const results = await Promise.all(
    prepared.map(async ({ cookie, ...body }) => {
      const start = performance.now();
      const response = await fetch(new URL("/api/judge/sheets", base), {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const value = (await response.json()) as { data?: { status?: string } };
      return {
        status: response.status,
        received: value.data?.status === "received",
        ms: performance.now() - start,
      };
    }),
  );
  const board = await fetch(new URL(`/api/t/${fixture.tournamentId}/live?round=2`, base), {
    headers: { Cookie: `dais.org=${fixture.ownerSession}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  const boardValue = (await board.json()) as {
    data?: {
      expected?: number;
      received?: number;
      totals?: { received?: number };
      counts?: { received: number; expected: number };
    };
  };
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    concurrency: 30,
    received: results.filter((r) => r.received && r.status === 200).length,
    statuses: results.reduce<Record<string, number>>((counts, r) => {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      return counts;
    }, {}),
    elapsedMs: Math.round(performance.now() - started),
    p50Ms: Math.round(latencies[14]),
    p95Ms: Math.round(latencies[28]),
    boardStatus: board.status,
    boardReceived:
      boardValue.data?.counts?.received ??
      boardValue.data?.received ??
      boardValue.data?.totals?.received,
  };
  console.log(JSON.stringify(summary));
  if (summary.received !== 30 || !board.ok || summary.boardReceived !== 30)
    throw new Error("load_acceptance");
}
if (process.argv[1]?.endsWith("load-judge.ts"))
  (process.argv.includes("--setup") ? setup() : run()).catch(() => {
    console.error(
      "Judge load check failed; no credentials printed. Inspect fixture freshness, guard flag and runtime configuration.",
    );
    process.exitCode = 1;
  });
