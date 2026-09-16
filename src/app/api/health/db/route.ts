/**
 * GET /api/health/db
 *
 * Readiness check. Runs `SELECT 1` through the shared database handle with a
 * three-second budget that also covers opening the connection (a suspended
 * Neon compute can take a moment to wake). Returns 503 with the standard error
 * envelope when the budget runs out or the query fails.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";

const TIMEOUT_MS = 3_000;

const headers = {
  "Cache-Control": "no-store",
  "X-Dais": "1",
};

export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const started = performance.now();
  try {
    await withTimeout(checkDatabase(), TIMEOUT_MS);
    const latencyMs = Math.round(performance.now() - started);
    return Response.json({ ok: true, db: "ok", latencyMs, requestId }, { headers });
  } catch (error: unknown) {
    return Response.json(
      {
        ok: false,
        db: "error",
        code: "db_unavailable",
        message: describe(error),
        retryable: true,
        requestId,
      },
      { status: 503, headers },
    );
  }
}

async function checkDatabase(): Promise<void> {
  const db = await getDb();
  await db.execute(sql`select 1`);
}

/** Rejects with a clear message when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Database did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Database check failed";
}
