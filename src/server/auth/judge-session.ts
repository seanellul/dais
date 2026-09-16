/**
 * Judge sessions: the `dais.judge` cookie, bound to one judge in one
 * tournament.
 *
 * A judge signs in by scanning a QR code (the join token) or typing the
 * tournament code and their judge code. Either way the phone gets a cookie
 * and a `sessions` row of kind `judge` that also records the judge's
 * `session_epoch` at the time. `revokeJudgeSessions` bumps the epoch, so
 * every device signed in as that judge is signed out at once, even a device
 * whose row a race missed. Sessions of withdrawn judges resolve to null.
 *
 * The judge app keeps its queued sheets when a session is revoked; a new
 * sign-in as the same judge resumes them. Nothing here deletes rows.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  judges,
  sessions,
  tournaments,
  type JudgeRow,
  type SessionRow,
  type TournamentRow,
} from "@/server/db";
import { errors } from "@/server/errors";
import {
  AUDIT_ACTIONS,
  hashToken,
  recordAudit,
  type Queryable,
  type ServiceContext,
} from "@/server/services";

import {
  expiryFrom,
  isSessionLive,
  newSessionToken,
  sessionCookieOptions,
  slideSession,
  type CookieStore,
  type IssuedSession,
  type SessionMeta,
} from "./session";

/** The judge session cookie. */
export const JUDGE_COOKIE = "dais.judge";

export interface ResolvedJudgeSession {
  session: SessionRow;
  judge: JudgeRow;
  tournament: TournamentRow;
}

/**
 * Issues a session for an active judge of `tournamentId`. The judge must
 * belong to that tournament; a judge id from another tournament is "not
 * found" rather than "forbidden" so the response reveals nothing.
 */
export async function createJudgeSession(
  tx: Queryable,
  ctx: ServiceContext,
  judgeId: string,
  tournamentId: string,
  meta: SessionMeta = {},
): Promise<IssuedSession> {
  const [judge] = await tx
    .select()
    .from(judges)
    .where(and(eq(judges.id, judgeId), eq(judges.tournamentId, tournamentId)))
    .limit(1);
  if (!judge) throw errors.notFound("That judge");
  if (judge.status !== "active") {
    throw errors.forbidden("This judge is no longer part of the tournament.");
  }

  const token = newSessionToken();
  const now = ctx.now();
  const [row] = await tx
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      kind: "judge",
      judgeId: judge.id,
      tournamentId: judge.tournamentId,
      epoch: judge.sessionEpoch,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: expiryFrom(now),
      userAgent: meta.userAgent ?? null,
      ipHash: meta.ipHash ?? null,
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row.id };
}

/**
 * Finds the live judge session behind a cookie token. Null when the token
 * is unknown, expired, revoked, from before an epoch bump, or belongs to a
 * judge who has been withdrawn.
 */
export async function resolveJudgeSession(
  db: Queryable,
  token: string,
  now: () => Date = () => new Date(),
): Promise<ResolvedJudgeSession | null> {
  if (!token) return null;
  const at = now();
  const [found] = await db
    .select({ session: sessions, judge: judges, tournament: tournaments })
    .from(sessions)
    .innerJoin(judges, eq(judges.id, sessions.judgeId))
    .innerJoin(tournaments, eq(tournaments.id, sessions.tournamentId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.kind, "judge")))
    .limit(1);
  if (!found || !isSessionLive(found.session, at)) return null;
  if (found.session.epoch !== found.judge.sessionEpoch) return null;
  if (found.judge.status !== "active") return null;

  const session = await slideSession(db, found.session, at);
  return { session, judge: found.judge, tournament: found.tournament };
}

/**
 * Signs a judge out of every device: bumps `session_epoch` (which also
 * rotates the judge's join token, see `tokens.ts`) and marks the live
 * session rows revoked. An organiser action, so it needs a reason and
 * writes an audit row.
 */
export async function revokeJudgeSessions(
  tx: Queryable,
  ctx: ServiceContext,
  judgeId: string,
  reason: string,
): Promise<{ epoch: number; revoked: number }> {
  if (reason.trim().length === 0) {
    throw errors.validation("Give a reason for signing the judge out. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  const [judge] = await tx.select().from(judges).where(eq(judges.id, judgeId)).limit(1);
  if (!judge) throw errors.notFound("That judge");

  const now = ctx.now();
  const epoch = judge.sessionEpoch + 1;
  await tx
    .update(judges)
    .set({ sessionEpoch: epoch, updatedAt: now })
    .where(eq(judges.id, judgeId));
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.judgeId, judgeId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  await recordAudit(tx, ctx, {
    tournamentId: judge.tournamentId,
    action: AUDIT_ACTIONS.judgesSessionsRevoked,
    entityType: "judge",
    entityId: judgeId,
    reason,
    after: { epoch, revoked: revoked.length },
  });
  return { epoch, revoked: revoked.length };
}

/** Writes the judge cookie. Accepts the promise `cookies()` returns. */
export async function setJudgeCookie(
  store: CookieStore | Promise<CookieStore>,
  token: string,
): Promise<void> {
  (await store).set(JUDGE_COOKIE, token, sessionCookieOptions());
}

/** Removes the judge cookie. */
export async function clearJudgeCookie(store: CookieStore | Promise<CookieStore>): Promise<void> {
  (await store).delete(JUDGE_COOKIE);
}
