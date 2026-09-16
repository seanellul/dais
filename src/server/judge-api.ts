import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { JudgeBootstrap } from "@/judge/api-types";
import {
  createJudgeSession,
  resolveJudgeSession,
  JUDGE_COOKIE,
  type ResolvedJudgeSession,
} from "@/server/auth/judge-session";
import { assertAllowed, RATE_LIMITS, rateLimitKey, takeAll } from "@/server/auth/rate-limit";
import { clientIpOf, ipHashOf, userAgentOf } from "@/server/auth/request-meta";
import { revokeSession, sessionCookieOptions } from "@/server/auth/session";
import { verifyJoinToken } from "@/server/auth/tokens";
import { assignments, getDb, judges, tournaments } from "@/server/db";
import { errors } from "@/server/errors";
import { getRequestId } from "@/server/request-id";
import {
  createContext,
  hashToken,
  loadGraph,
  withTransaction,
  type ServiceContext,
} from "@/server/services";
import { recordHeartbeat } from "@/server/services/heartbeat";
import { receiveSheet } from "@/server/services/sheets";
import { assertSameOrigin, cookieOf, httpError, json, readJsonBody } from "./http";

const code = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .transform((value) => value.toUpperCase());
const loginShape = z.object({ tournamentCode: code, judgeCode: code });
const joinShape = z.object({ token: z.string().min(1).max(512) });
const scoreShape = z.object({
  argumentation: z.number(),
  rebuttal: z.number(),
  presentation: z.number(),
  poi: z.number(),
  overall: z.number(),
  www: z.string(),
  ebi: z.string(),
});
const sheetShape = z.object({
  assignmentId: z.string().min(1).max(64),
  requestId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
  baseVersion: z.number().int().min(0),
  payload: z.object({
    scores: z.record(z.string(), scoreShape),
    sideFlipped: z.boolean(),
    roleSwaps: z.record(z.string(), z.boolean()),
  }),
});
const heartbeatShape = z.object({
  deviceId: z.string().trim().min(1).max(128),
  online: z.boolean().optional(),
  appVersion: z.string().max(64).nullish(),
  statuses: z
    .array(
      z.object({
        assignmentId: z.string().min(1).max(64),
        state: z.enum(["draft", "queued", "sending", "conflict", "attention", "received"]),
        filled: z.number().int().min(0).optional(),
        updatedAt: z.iso.datetime().optional(),
      }),
    )
    .max(200)
    .default([]),
});

async function context(
  request: Request,
  actor: ServiceContext["actor"] = { type: "system", id: "judge-api", name: "Judge API" },
): Promise<ServiceContext> {
  return createContext({ db: await getDb(), actor, requestId: getRequestId(request.headers) });
}
async function current(request: Request): Promise<ResolvedJudgeSession> {
  const found = await resolveJudgeSession(await getDb(), cookieOf(request, JUDGE_COOKIE));
  if (!found) throw errors.unauthenticated("Sign in with your judge code or QR card to continue.");
  return found;
}
function authenticated<T>(request: Request, data: T) {
  const response = json({ ok: true, data });
  response.cookies.set(JUDGE_COOKIE, cookieOf(request, JUDGE_COOKIE), sessionCookieOptions());
  return response;
}
async function bootstrap(found: ResolvedJudgeSession): Promise<JudgeBootstrap> {
  const graph = await loadGraph(await getDb(), found.tournament.id);
  return {
    judge: {
      id: found.judge.id,
      name: found.judge.name,
      homeRoomName: graph.rooms.find((room) => room.id === found.judge.homeRoomId)?.name ?? null,
    },
    tournament: {
      id: found.tournament.id,
      name: found.tournament.name,
      slug: found.tournament.slug,
      contact: found.tournament.settings.contact || null,
      rubric: found.tournament.settings.rubric,
      roles: found.tournament.settings.roles,
      timings: found.tournament.settings.timings,
      feedbackRequired: found.tournament.settings.feedbackRequired,
    },
    assignments: graph.assignments
      .filter((row) => row.judgeId === found.judge.id)
      .map((row) => {
        const sheet = graph.sheets.find((sheet) => sheet.assignmentId === row.id);
        return {
          id: row.id,
          identity: row.identity,
          display: row.display,
          retiredAt: row.retiredAt?.toISOString() ?? null,
          successorId: row.successorId,
          divisionFinalized:
            graph.divisions.find((division) => division.code === row.identity.divisionCode)
              ?.finalizedAt != null,
          roundStatus:
            graph.rounds.find((round) => round.number === row.identity.round)?.status ?? "pending",
          current: sheet
            ? {
                version: sheet.version,
                payload: {
                  scores: sheet.scores,
                  sideFlipped: sheet.sideFlipped,
                  roleSwaps: sheet.roleSwaps,
                },
                receivedAt: sheet.receivedAt.toISOString(),
              }
            : null,
          openConflict: graph.conflicts.some(
            (conflict) => conflict.assignmentId === row.id && conflict.status === "open",
          ),
        };
      }),
  };
}
async function countSignIn(request: Request, credential: string) {
  const c = await context(request);
  const decisions = await withTransaction(c, (tx) =>
    takeAll(
      tx,
      [
        {
          key: rateLimitKey("judge-signin", "ip", ipHashOf(clientIpOf(request.headers))),
          policy: RATE_LIMITS.judgeSignInPerIp,
        },
        {
          key: rateLimitKey("judge-signin", "code", hashToken(credential)),
          policy: RATE_LIMITS.judgeSignInPerCode,
        },
      ],
      c.now,
    ),
  );
  assertAllowed(decisions);
  return c;
}
async function signIn(request: Request, judgeId: string, tournamentId: string, c: ServiceContext) {
  const issued = await withTransaction(c, (tx) =>
    createJudgeSession(tx, c, judgeId, tournamentId, {
      userAgent: userAgentOf(request.headers),
      ipHash: ipHashOf(clientIpOf(request.headers)),
    }),
  );
  const response = json({ ok: true, data: { judgeId, tournamentId } });
  response.cookies.set(JUDGE_COOKIE, issued.token, sessionCookieOptions());
  return response;
}
export async function judgeLogin(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const body = loginShape.parse(await readJsonBody(request));
    const c = await countSignIn(request, `${body.tournamentCode}:${body.judgeCode}`);
    const [row] = await c.db
      .select({ judge: judges, tournament: tournaments })
      .from(judges)
      .innerJoin(tournaments, eq(tournaments.id, judges.tournamentId))
      .where(
        and(
          sql`upper(${tournaments.joinCode}) = ${body.tournamentCode}`,
          sql`upper(${judges.code}) = ${body.judgeCode}`,
        ),
      )
      .limit(1);
    if (!row || row.judge.status !== "active")
      throw errors.unauthenticated("That tournament code and judge code don't match.");
    return await signIn(request, row.judge.id, row.tournament.id, c);
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export async function judgeJoin(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const body = joinShape.parse(await readJsonBody(request));
    const c = await countSignIn(request, body.token);
    const result = await withTransaction(c, async (tx) => {
      // Revoke updates this same row. Hold SHARE until proof validation and
      // session creation commit, so a verified old QR cannot acquire a new epoch.
      const [locked] = await tx
        .select({ id: judges.id })
        .from(judges)
        .where(eq(judges.joinTokenHash, hashToken(body.token)))
        .limit(1)
        .for("share");
      if (!locked) throw errors.unauthenticated("That join link is not valid.");
      const judge = await verifyJoinToken(tx, body.token);
      if (!judge) throw errors.unauthenticated("That join link is not valid.");
      const issued = await createJudgeSession(tx, c, judge.id, judge.tournamentId, {
        userAgent: userAgentOf(request.headers),
        ipHash: ipHashOf(clientIpOf(request.headers)),
      });
      return { issued, judgeId: judge.id, tournamentId: judge.tournamentId };
    });
    const response = json({
      ok: true,
      data: { judgeId: result.judgeId, tournamentId: result.tournamentId },
    });
    response.cookies.set(JUDGE_COOKIE, result.issued.token, sessionCookieOptions());
    return response;
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export async function judgeMe(request: Request) {
  try {
    return authenticated(request, await bootstrap(await current(request)));
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export const judgeAssignments = judgeMe;
async function submit(request: Request, found: ResolvedJudgeSession, raw: unknown) {
  const body = sheetShape.parse(raw);
  // Check ownership before the service can return retirement/successor metadata.
  const [owned] = await (
    await getDb()
  )
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.id, body.assignmentId),
        eq(assignments.judgeId, found.judge.id),
        eq(assignments.tournamentId, found.tournament.id),
      ),
    )
    .limit(1);
  if (!owned) throw errors.forbidden("This sheet belongs to another judge or is unavailable.");
  const c = await context(request, { type: "judge", id: found.judge.id, name: found.judge.name });
  const receipt = await receiveSheet(c, {
    ...body,
    tournamentId: found.tournament.id,
    judgeId: found.judge.id,
  });
  if (receipt.status === "conflict") throw errors.versionConflict({ receipt });
  return receipt;
}
export async function judgeSheet(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const found = await current(request);
    return authenticated(request, await submit(request, found, await readJsonBody(request)));
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export async function judgeSync(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const found = await current(request);
    const batch = z
      .array(z.unknown())
      .max(20)
      .parse(await readJsonBody(request));
    const results = [];
    for (const item of batch) {
      const requestId = z.object({ requestId: z.string().max(128) }).safeParse(item);
      const id = requestId.success ? requestId.data.requestId : null;
      try {
        results.push({
          requestId: id,
          status: 200,
          ok: true,
          data: await submit(request, found, item),
        });
      } catch (error) {
        const response = httpError(error, request.headers);
        results.push({
          requestId: id,
          status: response.status,
          ok: false,
          error: await response.json(),
        });
      }
    }
    return authenticated(request, results);
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export async function judgeHeartbeat(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const found = await current(request);
    const body = heartbeatShape.parse(await readJsonBody(request));
    const owned = await (
      await getDb()
    )
      .select({ id: assignments.id })
      .from(assignments)
      .where(
        and(
          eq(assignments.judgeId, found.judge.id),
          eq(assignments.tournamentId, found.tournament.id),
        ),
      );
    const ids = new Set(owned.map((row) => row.id));
    if (body.statuses.some((status) => !ids.has(status.assignmentId)))
      throw errors.forbidden("This sheet belongs to another judge.");
    const c = await context(request, { type: "judge", id: found.judge.id, name: found.judge.name });
    return authenticated(
      request,
      await recordHeartbeat(c, {
        ...body,
        judgeId: found.judge.id,
        tournamentId: found.tournament.id,
        userAgent: userAgentOf(request.headers),
      }),
    );
  } catch (error) {
    return httpError(error, request.headers);
  }
}
export async function judgeLogout(request: Request) {
  try {
    assertSameOrigin(request.headers);
    const found = await current(request);
    const c = await context(request, { type: "judge", id: found.judge.id, name: found.judge.name });
    await withTransaction(c, (tx) => revokeSession(tx, c, found.session.id, "Judge signed out"));
    const response = json({ ok: true, data: { signedOut: true } });
    response.cookies.delete(JUDGE_COOKIE);
    return response;
  } catch (error) {
    return httpError(error, request.headers);
  }
}
