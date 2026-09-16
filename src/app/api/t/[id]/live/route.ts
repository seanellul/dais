import { eq } from "drizzle-orm";
import { z } from "zod";

import { ORGANISER_COOKIE, resolveUserSession, sessionCookieOptions } from "@/server/auth/session";
import { getDb, tournaments } from "@/server/db";
import { errors } from "@/server/errors";
import { cookieOf, httpError, json } from "@/server/http";
import { loadGraph } from "@/server/services";
import { buildLiveBoard } from "@/server/services/live";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const db = await getDb();
    const token = cookieOf(request, ORGANISER_COOKIE);
    const found = await resolveUserSession(db, token);
    if (!found) throw errors.unauthenticated();
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw errors.notFound("That tournament");
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
    if (!tournament) throw errors.notFound("That tournament");
    if (!found.memberships.some((member) => member.organisationId === tournament.organisationId))
      throw errors.forbidden();
    const graph = await loadGraph(db, id);
    const roundQuery = new URL(request.url).searchParams.get("round");
    const round =
      roundQuery === null
        ? (graph.rounds.find((row) => row.status === "open")?.number ?? graph.rounds[0]?.number)
        : z.coerce.number().int().positive().parse(roundQuery);
    if (round === undefined) throw errors.notFound("That round");
    const response = json({ ok: true, data: buildLiveBoard(graph, round, new Date()) });
    response.cookies.set(ORGANISER_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    return httpError(error, request.headers);
  }
}
