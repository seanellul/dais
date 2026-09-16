/**
 * Organiser sessions and the cookie that carries them.
 *
 * A session is a random token in an httpOnly cookie (`dais.org`) and a row
 * in `sessions` holding `hashToken(token)`, never the token itself. The row
 * expires 30 days after it was last seen; `resolveUserSession` slides that
 * expiry forward, but at most once an hour so a busy dashboard does not
 * write on every request. The cookie's own `maxAge` is 30 days from the
 * response that set it, so `src/proxy.ts` sets it again on every organiser
 * page (`/t/...`) and the browser keeps pace with the sliding row. Signing
 * out, "sign out everywhere" and a password reset set `revoked_at`; rows
 * are never deleted, so the history of who was signed in from where
 * survives.
 *
 * The functions here take a database handle, not Next's request APIs, so the
 * integration suite can exercise them on PGlite. `guards.ts` and the Server
 * Actions are the only places that touch `cookies()`.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  memberships,
  sessions,
  users,
  type MembershipRow,
  type SessionRow,
  type UserRow,
} from "@/server/db";
import { getEnv } from "@/server/env";
import { hashToken, randomToken, type Queryable, type ServiceContext } from "@/server/services";

import { AUTH_AUDIT_ACTIONS, recordAuthAudit } from "./audit-actions";

/** The organiser session cookie. */
export const ORGANISER_COOKIE = "dais.org";

/** A session lives this long after it was last seen. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` and `expires_at` move forward at most this often. */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;

/** What the sign-in form knows about the device, stored on the session row. */
export interface SessionMeta {
  userAgent?: string | null;
  /** From `ipHashOf`; never a raw address. */
  ipHash?: string | null;
}

/** The plaintext token (for the cookie) and the row id (for revocation). */
export interface IssuedSession {
  token: string;
  sessionId: string;
}

export interface ResolvedUserSession {
  session: SessionRow;
  user: UserRow;
  memberships: MembershipRow[];
}

/**
 * The part of Next's `cookies()` store the auth layer uses. Declared here so
 * this module stays free of Next imports; the real store satisfies it.
 */
export interface CookieStore {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: CookieOptions): unknown;
  delete(name: string): unknown;
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  path: string;
  maxAge: number;
}

/** Issues a session for `userId` and returns the token to put in the cookie. */
export async function createUserSession(
  tx: Queryable,
  ctx: ServiceContext,
  userId: string,
  meta: SessionMeta = {},
): Promise<IssuedSession> {
  const token = newSessionToken();
  const now = ctx.now();
  const [row] = await tx
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      kind: "organiser",
      userId,
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
 * Finds the live session behind a cookie token, with its user and the
 * user's memberships. Null when the token is unknown, expired or revoked.
 * Slides the expiry when the row was last seen more than an hour ago.
 */
export async function resolveUserSession(
  db: Queryable,
  token: string,
  now: () => Date = () => new Date(),
): Promise<ResolvedUserSession | null> {
  if (!token) return null;
  const at = now();
  const [found] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.kind, "organiser")))
    .limit(1);
  if (!found || !isSessionLive(found.session, at)) return null;

  const session = await slideSession(db, found.session, at);
  const memberOf = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, found.user.id))
    .orderBy(memberships.createdAt);
  return { session, user: found.user, memberships: memberOf };
}

/**
 * Revokes one session. Returns false when it was already revoked or does
 * not exist, so a double sign-out is harmless.
 */
export async function revokeSession(
  tx: Queryable,
  ctx: ServiceContext,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: ctx.now(), revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length > 0;
}

/**
 * Revokes every live organiser session of a user ("sign out everywhere",
 * a password reset). `except` keeps one session, so a user who changes
 * their password stays signed in on the device they used. Writes one audit
 * row; the reason is what the history shows.
 */
export async function revokeAllUserSessions(
  tx: Queryable,
  ctx: ServiceContext,
  userId: string,
  reason: string,
  options: { except?: string } = {},
): Promise<number> {
  const live = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  const targets = live.map((row) => row.id).filter((id) => id !== options.except);

  for (const id of targets) {
    await revokeSession(tx, ctx, id, reason);
  }
  await recordAuthAudit(tx, ctx, {
    action: AUTH_AUDIT_ACTIONS.userSessionsRevoked,
    entityType: "user",
    entityId: userId,
    reason,
    after: { revoked: targets.length },
  });
  return targets.length;
}

/**
 * The cookie attributes for both organiser and judge cookies. `secure`
 * follows `APP_URL`, so a LAN self-host on plain http still gets a cookie
 * and a public https deployment never sends one in clear. `maxAge` counts
 * from the response that sets it; see the header for how it keeps up with
 * the sliding row.
 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: getEnv().APP_URL.startsWith("https"),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Writes the organiser cookie. Accepts the promise `cookies()` returns. */
export async function setSessionCookie(
  store: CookieStore | Promise<CookieStore>,
  token: string,
): Promise<void> {
  (await store).set(ORGANISER_COOKIE, token, sessionCookieOptions());
}

/** Removes the organiser cookie. */
export async function clearSessionCookie(store: CookieStore | Promise<CookieStore>): Promise<void> {
  (await store).delete(ORGANISER_COOKIE);
}

// ---------------------------------------------------------------------------
// Shared with judge sessions
// ---------------------------------------------------------------------------

/** 32 random bytes as base64url: 43 characters, safe in a cookie. */
export function newSessionToken(): string {
  return randomToken(32);
}

/** When a session seen at `now` expires. */
export function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/** True when the row is neither revoked nor past its expiry. */
export function isSessionLive(session: SessionRow, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/**
 * Moves `last_seen_at` and `expires_at` forward when the row was last seen
 * more than `SESSION_SLIDE_INTERVAL_MS` ago. Returns the row as it now is.
 */
export async function slideSession(
  db: Queryable,
  session: SessionRow,
  now: Date,
): Promise<SessionRow> {
  const lastSeen = session.lastSeenAt?.getTime() ?? 0;
  if (now.getTime() - lastSeen < SESSION_SLIDE_INTERVAL_MS) return session;
  const next = { lastSeenAt: now, expiresAt: expiryFrom(now) };
  await db.update(sessions).set(next).where(eq(sessions.id, session.id));
  return { ...session, ...next };
}
