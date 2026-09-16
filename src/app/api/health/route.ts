/**
 * GET /api/health
 *
 * Liveness check. Answers without touching the database, so a stuck database
 * never makes the app look down, and the judge PWA can use it to confirm it
 * has a real connection (a captive portal returns HTML, not this JSON).
 *
 * `version` names the build that answers: `DAIS_VERSION` (the Docker image
 * sets it from a build argument), else Vercel's commit SHA, else "dev".
 */
export async function GET(): Promise<Response> {
  return Response.json(
    {
      ok: true,
      version: process.env.DAIS_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
      time: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Dais": "1",
      },
    },
  );
}
