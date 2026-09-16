/**
 * Authentication against a real (embedded) Postgres: first-run sign-up,
 * sign-in with rate limits, organiser and judge sessions, join tokens,
 * invites and the fixed-window limiter itself.
 *
 * Every test seeds its own organisation and uses unique emails, keys and
 * addresses, so the file also runs against a shared Postgres
 * (`DATABASE_URL_TEST`). The one exception is first-run sign-up, which by
 * design succeeds only on an empty instance; on a shared database the test
 * checks the refusal alone.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  JUDGE_COOKIE,
  ORGANISER_COOKIE,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  acceptInvite,
  assertAllowed,
  createInvite,
  createJudgeSession,
  createUser,
  createUserSession,
  enforceAll,
  findLiveInvite,
  issueJoinToken,
  joinLinkFor,
  joinTokenFor,
  resolveJudgeSession,
  resolveUserSession,
  revokeAllUserSessions,
  revokeJudgeSessions,
  revokeSession,
  sessionCookieOptions,
  sweep,
  take,
  takeAll,
  verifyJoinToken,
} from "@/server/auth";
import {
  auditLog,
  invites,
  judges,
  memberships,
  organisations,
  rateLimits,
  sessions,
  users,
  type Db,
} from "@/server/db";
import { getDb } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { isAppError } from "@/server/errors";
import { hashToken, run, withTransaction, type ServiceContext } from "@/server/services";
import {
  changePassword,
  listSessions,
  resetPasswordByCli,
  signIn,
  signOutEverywhere,
  signUpFirstOwner,
} from "@/server/services/users";
import { acceptInviteWithSession } from "@/server/auth/invite-acceptance";
import { RATE_LIMITS, rateLimitKey, windowKey } from "@/server/auth/rate-limit";
import { ipHashOf } from "@/server/auth/request-meta";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

const PASSWORD = "a long enough password";
const T0 = new Date("2026-09-16T09:00:00Z");

/** A context frozen at `at`, quiet because many tests provoke errors. */
function contextAt(db: Db, at: Date): ServiceContext {
  return testContext(db, { now: () => at, log: silentLogger });
}

/** A unique, invented email. */
function email(): string {
  return `organiser-${randomUUID().slice(0, 8)}@example.test`;
}

/** A unique, invented client address. */
function address(): string {
  return `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 6)}`;
}

/** Runs `work` and returns whatever it threw. */
async function caught(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Creates a user with a password and returns it with the email used. */
async function seedUser(db: Db, ctx: ServiceContext, mail = email()) {
  const user = await withTransaction(ctx, (tx) =>
    createUser(tx, ctx, mail, "Sam Organiser", PASSWORD),
  );
  return { user, email: mail };
}

describe("first-run sign-up", () => {
  it("creates the owner and organisation once, then refuses with an invite hint", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const [existing] = await db.select({ id: organisations.id }).from(organisations).limit(1);

    if (!existing) {
      const signedUp = await withTransaction(ctx, (tx) =>
        signUpFirstOwner(tx, ctx, {
          orgName: "Sample Debating Society",
          email: email(),
          name: "Sam Owner",
          password: PASSWORD,
        }),
      );
      expect(signedUp.membership.role).toBe("owner");
      expect(signedUp.organisation.slug).toBe("sample-debating-society");
      expect(signedUp.user.passwordHash).toMatch(/^scrypt\$/);
      const trail = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, signedUp.organisation.id));
      expect(trail.map((row) => row.action)).toContain("organisation.created");
    }

    const second = await caught(
      withTransaction(ctx, (tx) =>
        signUpFirstOwner(tx, ctx, {
          orgName: "Another Society",
          email: email(),
          name: "Late Comer",
          password: PASSWORD,
        }),
      ),
    );
    expect(isAppError(second) && second.code).toBe("forbidden");
    expect(isAppError(second) && second.message).toMatch(/invite/);
  });

  it("refuses a short password with a plain message", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const error = await caught(
      withTransaction(ctx, (tx) => createUser(tx, ctx, email(), "Sam", "short")),
    );
    expect(isAppError(error) && error.code).toBe("validation");
    expect(isAppError(error) && error.message).toBe("Use a password of at least 10 characters.");
  });
});

describe("sign-in", () => {
  it("returns a session token and stores only its hash", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user, email: mail } = await seedUser(db, ctx);

    const signedIn = await signIn(ctx, {
      email: mail.toUpperCase(),
      password: PASSWORD,
      ip: address(),
      userAgent: "Sample Browser/1.0",
    });
    expect(signedIn.user.id).toBe(user.id);
    expect(signedIn.token.length).toBeGreaterThanOrEqual(40);

    const plaintext = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, signedIn.token));
    expect(plaintext).toHaveLength(0);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(signedIn.token)));
    expect(row.id).toBe(signedIn.sessionId);
    expect(row.kind).toBe("organiser");
    expect(row.userAgent).toBe("Sample Browser/1.0");
    expect(row.expiresAt.getTime()).toBe(T0.getTime() + SESSION_TTL_MS);

    const [updated] = await db.select().from(users).where(eq(users.id, user.id));
    expect(updated.lastLoginAt?.getTime()).toBe(T0.getTime());
  });

  it("fails the same way for a wrong password and an unknown email", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { email: mail } = await seedUser(db, ctx);

    const wrong = await run(ctx, () =>
      signIn(ctx, { email: mail, password: "not the password", ip: address() }),
    );
    const unknown = await run(ctx, () =>
      signIn(ctx, { email: email(), password: PASSWORD, ip: address() }),
    );
    expect(wrong.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (wrong.ok || unknown.ok) return;
    expect(wrong.error.code).toBe("unauthenticated");
    expect(unknown.error).toMatchObject({ code: "unauthenticated", message: wrong.error.message });
  });

  it("counts failed attempts and rate limits the email after five", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { email: mail } = await seedUser(db, ctx);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await caught(signIn(ctx, { email: mail, password: "wrong", ip: address() }));
      expect(isAppError(attempt) && attempt.code).toBe("unauthenticated");
    }
    const sixth = await caught(signIn(ctx, { email: mail, password: PASSWORD, ip: address() }));
    expect(isAppError(sixth) && sixth.code).toBe("rate_limited");
    expect(isAppError(sixth) && sixth.details?.retryAfter).toBeGreaterThan(0);
  });

  it("lets an organiser sign in on many devices: only failures use up the email budget", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user, email: mail } = await seedUser(db, ctx);
    const limit = RATE_LIMITS.organiserSignInPerEmail.limit;

    // Laptop, projector PC, phone, tablet, laptop again: one more than the limit.
    for (let device = 0; device <= limit; device += 1) {
      const signedIn = await signIn(ctx, {
        email: mail,
        password: PASSWORD,
        ip: address(),
        userAgent: `Device ${device}`,
      });
      expect(signedIn.user.id).toBe(user.id);
    }
    expect(await listSessions(db, user.id, () => T0)).toHaveLength(limit + 1);

    // A success clears the window, so a later wrong password starts from one.
    const key = windowKey(
      rateLimitKey("organiser-signin", "email", mail),
      RATE_LIMITS.organiserSignInPerEmail,
      T0,
    );
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, key))).toHaveLength(0);
    await caught(signIn(ctx, { email: mail, password: "wrong", ip: address() }));
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0]).toMatchObject({
      tokens: 1,
    });
  });
});

describe("organiser sessions", () => {
  it("resolves a live session with its user and memberships", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const { token, sessionId } = await withTransaction(ctx, (tx) =>
      createUserSession(tx, ctx, seeded.userId),
    );

    const resolved = await resolveUserSession(db, token, () => T0);
    expect(resolved?.session.id).toBe(sessionId);
    expect(resolved?.user.id).toBe(seeded.userId);
    expect(resolved?.memberships.map((m) => [m.organisationId, m.role])).toEqual([
      [seeded.organisationId, "owner"],
    ]);
    expect(await resolveUserSession(db, "not-a-token", () => T0)).toBeNull();
    expect(await resolveUserSession(db, "", () => T0)).toBeNull();
  });

  it("slides the expiry at most once an hour", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user } = await seedUser(db, ctx);
    const { token } = await withTransaction(ctx, (tx) => createUserSession(tx, ctx, user.id));

    const soon = new Date(T0.getTime() + SESSION_SLIDE_INTERVAL_MS / 2);
    const unchanged = await resolveUserSession(db, token, () => soon);
    expect(unchanged?.session.lastSeenAt?.getTime()).toBe(T0.getTime());
    expect(unchanged?.session.expiresAt.getTime()).toBe(T0.getTime() + SESSION_TTL_MS);

    const later = new Date(T0.getTime() + SESSION_SLIDE_INTERVAL_MS + 1000);
    const slid = await resolveUserSession(db, token, () => later);
    expect(slid?.session.lastSeenAt?.getTime()).toBe(later.getTime());
    expect(slid?.session.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, slid!.session.id));
    expect(stored.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
  });

  it("honours expiry and revocation", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user } = await seedUser(db, ctx);
    const { token, sessionId } = await withTransaction(ctx, (tx) =>
      createUserSession(tx, ctx, user.id),
    );

    const afterExpiry = new Date(T0.getTime() + SESSION_TTL_MS + 1);
    expect(await resolveUserSession(db, token, () => afterExpiry)).toBeNull();

    expect(await resolveUserSession(db, token, () => T0)).not.toBeNull();
    const revoked = await withTransaction(ctx, (tx) =>
      revokeSession(tx, ctx, sessionId, "signed out"),
    );
    expect(revoked).toBe(true);
    expect(await resolveUserSession(db, token, () => T0)).toBeNull();
    const again = await withTransaction(ctx, (tx) =>
      revokeSession(tx, ctx, sessionId, "signed out"),
    );
    expect(again).toBe(false);
  });

  it("signs out everywhere, keeping one session when asked, and lists live sessions", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user } = await seedUser(db, ctx);
    const issued = await withTransaction(ctx, async (tx) => [
      await createUserSession(tx, ctx, user.id, { userAgent: "Phone" }),
      await createUserSession(tx, ctx, user.id, { userAgent: "Laptop" }),
      await createUserSession(tx, ctx, user.id, { userAgent: "Tablet" }),
    ]);

    const listed = await listSessions(db, user.id, () => T0);
    expect(listed.map((s) => s.userAgent).sort()).toEqual(["Laptop", "Phone", "Tablet"]);
    expect(Object.keys(listed[0])).not.toContain("tokenHash");

    const kept = issued[1].sessionId;
    const count = await withTransaction(ctx, (tx) =>
      revokeAllUserSessions(tx, ctx, user.id, "sign out everywhere", { except: kept }),
    );
    expect(count).toBe(2);
    expect(await resolveUserSession(db, issued[0].token, () => T0)).toBeNull();
    expect(await resolveUserSession(db, issued[1].token, () => T0)).not.toBeNull();

    expect(await withTransaction(ctx, (tx) => signOutEverywhere(tx, ctx, user.id))).toBe(1);
    expect(await listSessions(db, user.id, () => T0)).toEqual([]);
  });

  it("changes a password after checking the current one and keeps only this device", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user, email: mail } = await seedUser(db, ctx);
    const here = await withTransaction(ctx, (tx) => createUserSession(tx, ctx, user.id));
    const elsewhere = await withTransaction(ctx, (tx) => createUserSession(tx, ctx, user.id));

    const wrong = await caught(
      withTransaction(ctx, (tx) =>
        changePassword(tx, ctx, {
          userId: user.id,
          currentPassword: "not it",
          newPassword: "another long password",
        }),
      ),
    );
    expect(isAppError(wrong) && wrong.code).toBe("validation");

    await withTransaction(ctx, (tx) =>
      changePassword(tx, ctx, {
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: "another long password",
        keepSessionId: here.sessionId,
      }),
    );
    expect(await resolveUserSession(db, here.token, () => T0)).not.toBeNull();
    expect(await resolveUserSession(db, elsewhere.token, () => T0)).toBeNull();
    const signedIn = await signIn(ctx, {
      email: mail,
      password: "another long password",
      ip: address(),
    });
    expect(signedIn.user.id).toBe(user.id);
  });

  it("resets a password from the CLI and signs every device out", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const { user, email: mail } = await seedUser(db, ctx);
    const { token } = await withTransaction(ctx, (tx) => createUserSession(tx, ctx, user.id));

    await withTransaction(ctx, (tx) =>
      resetPasswordByCli(tx, ctx, mail, "reset by the host admin"),
    );
    expect(await resolveUserSession(db, token, () => T0)).toBeNull();
    const signedIn = await signIn(ctx, {
      email: mail,
      password: "reset by the host admin",
      ip: address(),
    });
    expect(signedIn.user.id).toBe(user.id);

    const missing = await caught(
      withTransaction(ctx, (tx) => resetPasswordByCli(tx, ctx, email(), "reset by the host admin")),
    );
    expect(isAppError(missing) && missing.code).toBe("not_found");
  });

  it("names the cookies and makes them httpOnly, lax and secure only over https", () => {
    expect(ORGANISER_COOKIE).toBe("dais.org");
    expect(JUDGE_COOKIE).toBe("dais.judge");
    const previousAppUrl = process.env.APP_URL;
    try {
      process.env.APP_URL = "http://localhost:3000";
      resetEnvCache();
      expect(sessionCookieOptions()).toMatchObject({
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      });

      process.env.APP_URL = "https://dais.example";
      resetEnvCache();
      expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, secure: true });
    } finally {
      if (previousAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previousAppUrl;
      resetEnvCache();
    }
  });
});

describe("judge sessions and join tokens", () => {
  it("resolves a judge session with its tournament, and an epoch bump signs every device out", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const sample = await seedSample(db, seeded.tournamentId, { open: 4, novice: 0, rooms: 2 });
    const judge = sample.judges[0];

    const phone = await withTransaction(ctx, (tx) =>
      createJudgeSession(tx, ctx, judge.id, seeded.tournamentId, { userAgent: "Phone" }),
    );
    const tablet = await withTransaction(ctx, (tx) =>
      createJudgeSession(tx, ctx, judge.id, seeded.tournamentId),
    );
    const resolved = await resolveJudgeSession(db, phone.token, () => T0);
    expect(resolved?.judge.id).toBe(judge.id);
    expect(resolved?.tournament.id).toBe(seeded.tournamentId);
    expect(resolved?.session.epoch).toBe(0);
    expect(await resolveUserSession(db, phone.token, () => T0)).toBeNull(); // wrong kind

    const result = await withTransaction(ctx, (tx) =>
      revokeJudgeSessions(tx, ctx, judge.id, "lost phone"),
    );
    expect(result).toEqual({ epoch: 1, revoked: 2 });
    expect(await resolveJudgeSession(db, phone.token, () => T0)).toBeNull();
    expect(await resolveJudgeSession(db, tablet.token, () => T0)).toBeNull();

    const [trail] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "judges.sessions_revoked"), eq(auditLog.entityId, judge.id)));
    expect(trail.reason).toBe("lost phone");
    expect(trail.tournamentId).toBe(seeded.tournamentId);

    const fresh = await withTransaction(ctx, (tx) =>
      createJudgeSession(tx, ctx, judge.id, seeded.tournamentId),
    );
    expect((await resolveJudgeSession(db, fresh.token, () => T0))?.session.epoch).toBe(1);
  });

  it("refuses to sign a judge out without a reason", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const sample = await seedSample(db, seeded.tournamentId, { open: 4, novice: 0, rooms: 2 });
    const error = await caught(
      withTransaction(ctx, (tx) => revokeJudgeSessions(tx, ctx, sample.judges[0].id, "  ")),
    );
    expect(isAppError(error) && error.code).toBe("validation");
  });

  it("does not resolve a withdrawn judge, and refuses a judge from another tournament", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const other = await seedTournament(db);
    const sample = await seedSample(db, seeded.tournamentId, { open: 4, novice: 0, rooms: 2 });
    const judge = sample.judges[1];

    const { token } = await withTransaction(ctx, (tx) =>
      createJudgeSession(tx, ctx, judge.id, seeded.tournamentId),
    );
    await db.update(judges).set({ status: "withdrawn" }).where(eq(judges.id, judge.id));
    expect(await resolveJudgeSession(db, token, () => T0)).toBeNull();
    const withdrawn = await caught(
      withTransaction(ctx, (tx) => createJudgeSession(tx, ctx, judge.id, seeded.tournamentId)),
    );
    expect(isAppError(withdrawn) && withdrawn.code).toBe("forbidden");

    const elsewhere = await caught(
      withTransaction(ctx, (tx) =>
        createJudgeSession(tx, ctx, sample.judges[2].id, other.tournamentId),
      ),
    );
    expect(isAppError(elsewhere) && elsewhere.code).toBe("not_found");
  });

  it("issues a join token that verifies, is stable, and rotates with the epoch", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const sample = await seedSample(db, seeded.tournamentId, { open: 4, novice: 0, rooms: 2 });
    const judge = sample.judges[0];

    // The seed stored a random hash; the derived token is unknown until issued.
    expect(await verifyJoinToken(db, joinTokenFor(judge))).toBeNull();

    const token = await withTransaction(ctx, (tx) => issueJoinToken(tx, ctx, judge.id));
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await withTransaction(ctx, (tx) => issueJoinToken(tx, ctx, judge.id))).toBe(token);
    expect((await verifyJoinToken(db, token))?.id).toBe(judge.id);
    expect(await verifyJoinToken(db, "")).toBeNull();
    expect(joinLinkFor(token)).toBe(`http://localhost:3000/j/join?t=${token}`);

    const [stored] = await db.select().from(judges).where(eq(judges.id, judge.id));
    expect(stored.joinTokenHash).not.toBe(token);
    expect(stored.joinTokenHash).toBe(hashToken(token));

    await withTransaction(ctx, (tx) => revokeJudgeSessions(tx, ctx, judge.id, "replaced card"));
    expect(await verifyJoinToken(db, token)).toBeNull();
    const rotated = await withTransaction(ctx, (tx) => issueJoinToken(tx, ctx, judge.id));
    expect(rotated).not.toBe(token);
    expect((await verifyJoinToken(db, rotated))?.id).toBe(judge.id);
  });
});

describe("invites", () => {
  it("creates a single-use invite that makes a user and a membership", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const mail = email();

    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: seeded.organisationId,
        email: mail,
        role: "organiser",
        invitedBy: seeded.userId,
      }),
    );
    expect(invite.expiresAt.getTime()).toBe(T0.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.inviteId));
    expect(row.tokenHash).toBe(hashToken(invite.token));

    const live = await findLiveInvite(db, invite.token, () => T0);
    expect(live.organisation.id).toBe(seeded.organisationId);

    const accepted = await withTransaction(ctx, (tx) =>
      acceptInvite(tx, ctx, invite.token, { name: "New Organiser", password: PASSWORD }),
    );
    expect(accepted.existingUser).toBe(false);
    expect(accepted.user.email).toBe(mail);
    expect(accepted.membership).toMatchObject({
      organisationId: seeded.organisationId,
      userId: accepted.user.id,
      role: "organiser",
    });
    const signedIn = await signIn(ctx, { email: mail, password: PASSWORD, ip: address() });
    expect(signedIn.user.id).toBe(accepted.user.id);

    const again = await caught(
      withTransaction(ctx, (tx) =>
        acceptInvite(tx, ctx, invite.token, { name: "Someone Else", password: PASSWORD }),
      ),
    );
    expect(isAppError(again) && again.message).toMatch(/already been used/);
  });

  it("refuses expired and unknown invites in plain words", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const seeded = await seedTournament(db);
    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: seeded.organisationId,
        email: email(),
        role: "organiser",
        invitedBy: seeded.userId,
      }),
    );

    const eightDaysOn = contextAt(db, new Date(T0.getTime() + 8 * 24 * 60 * 60 * 1000));
    const expired = await caught(
      withTransaction(eightDaysOn, (tx) =>
        acceptInvite(tx, eightDaysOn, invite.token, { name: "Late", password: PASSWORD }),
      ),
    );
    expect(isAppError(expired) && expired.message).toMatch(/expired/);

    const unknown = await caught(
      withTransaction(ctx, (tx) =>
        acceptInvite(tx, ctx, "nope", { name: "X", password: PASSWORD }),
      ),
    );
    expect(isAppError(unknown) && unknown.message).toMatch(/not valid/);
  });

  it("joins an existing account only with its password, and never changes that password", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const home = await seedTournament(db);
    const away = await seedTournament(db);
    const { user, email: mail } = await seedUser(db, ctx);
    const before = (await db.select().from(users).where(eq(users.id, user.id)))[0].passwordHash;

    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: away.organisationId,
        email: mail,
        role: "owner",
        invitedBy: away.userId,
      }),
    );
    const wrong = await caught(
      withTransaction(ctx, (tx) =>
        acceptInvite(tx, ctx, invite.token, { name: "Ignored", password: "wrong password" }),
      ),
    );
    expect(isAppError(wrong) && wrong.code).toBe("unauthenticated");
    expect(
      await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.organisationId, away.organisationId), eq(memberships.userId, user.id)),
        ),
    ).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    const accepted = await withTransaction(ctx, (tx) =>
      acceptInvite(tx, ctx, invite.token, { name: "Ignored", password: PASSWORD }),
    );
    expect(accepted.existingUser).toBe(true);
    expect(accepted.user.id).toBe(user.id);
    const after = (await db.select().from(users).where(eq(users.id, user.id)))[0].passwordHash;
    expect(after).toBe(before);
    const rows = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    expect(rows.map((m) => m.organisationId)).toEqual([away.organisationId]);
    expect(rows.map((m) => m.organisationId)).not.toContain(home.organisationId);
  });

  it("gives a double-submitted link one winner and tells the other it has been used", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const away = await seedTournament(db);
    const { user, email: mail } = await seedUser(db, ctx);
    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: away.organisationId,
        email: mail,
        role: "organiser",
        invitedBy: away.userId,
      }),
    );

    // The invite is claimed before the membership is written, so the loser
    // sees the used-link message, never a unique violation from memberships.
    const attempt = () =>
      withTransaction(ctx, (tx) =>
        acceptInvite(tx, ctx, invite.token, { name: "Sam Organiser", password: PASSWORD }),
      );
    const outcomes = await Promise.all([caught(attempt()), caught(attempt())]);
    const failures = outcomes.filter((outcome) => outcome !== undefined);
    expect(failures).toHaveLength(1);
    expect(isAppError(failures[0]) && failures[0].code).toBe("validation");
    expect(isAppError(failures[0]) && failures[0].message).toMatch(/already been used/);
    expect(
      await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.organisationId, away.organisationId), eq(memberships.userId, user.id)),
        ),
    ).toHaveLength(1);
  });
});

describe("rate limits", () => {
  const policy = { limit: 3, windowSeconds: 60 };

  it("allows up to the limit, then says how long to wait", async () => {
    const db = await getDb();
    const key = `test:${randomUUID()}`;
    const at = new Date("2026-09-16T10:00:10Z");
    const now = () => at;

    expect(await take(db, key, policy, now)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    expect((await take(db, key, policy, now)).remaining).toBe(1);
    expect((await take(db, key, policy, now)).remaining).toBe(0);
    const blocked = await take(db, key, policy, now);
    expect(blocked).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 50 });

    const nextWindow = () => new Date("2026-09-16T10:01:00Z");
    expect((await take(db, key, policy, nextWindow)).allowed).toBe(true);
  });

  it("counts correctly when two transactions take the same key at once", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const key = `test:${randomUUID()}`;
    const [a, b] = await Promise.all([
      withTransaction(ctx, (tx) => take(tx, key, policy, ctx.now)),
      withTransaction(ctx, (tx) => take(tx, key, policy, ctx.now)),
    ]);
    expect([a.remaining, b.remaining].sort()).toEqual([1, 2]);
    const rows = await db
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, `${key}@${windowStart(T0)}`));
    expect(rows[0].tokens).toBe(2);
  });

  it("charges every limit, keeps the count after a block, and waits for the longest", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const tight = { key: `test:${randomUUID()}`, policy: { limit: 1, windowSeconds: 60 } };
    const loose = { key: `test:${randomUUID()}`, policy: { limit: 5, windowSeconds: 900 } };

    await withTransaction(ctx, (tx) => enforceAll(tx, [tight, loose], ctx.now));
    // Count inside the transaction, judge after it commits, as signIn does.
    const decisions = await withTransaction(ctx, (tx) => takeAll(tx, [tight, loose], ctx.now));
    const error = await caught(Promise.resolve().then(() => assertAllowed(decisions)));
    expect(isAppError(error) && error.code).toBe("rate_limited");
    expect(isAppError(error) && error.details?.retryAfter).toBe(60);
    // The loose limit was charged twice even though the tight one blocked.
    expect((await take(db, loose.key, loose.policy, ctx.now)).remaining).toBe(2);

    // Throwing inside the transaction would have undone the count; on a plain
    // handle each take is its own statement, so enforceAll keeps it.
    const plain = { key: `test:${randomUUID()}`, policy: { limit: 1, windowSeconds: 60 } };
    await enforceAll(db, [plain], ctx.now);
    expect(isAppError(await caught(enforceAll(db, [plain], ctx.now)))).toBe(true);
    expect((await take(db, plain.key, plain.policy, ctx.now)).remaining).toBe(0);
  });

  it("sweeps rows from windows that are long over", async () => {
    const db = await getDb();
    const key = `test:${randomUUID()}`;
    const old = () => new Date("2026-01-01T00:00:00Z");
    await take(db, key, policy, old);
    expect(await sweep(db, new Date("2026-01-02T00:00:00Z"))).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, `${key}@${windowStart(old())}`));
    expect(rows).toHaveLength(0);
  });

  function windowStart(at: Date): number {
    const seconds = Math.floor(at.getTime() / 1000);
    return seconds - (seconds % policy.windowSeconds);
  }
});

describe("invite password attempt limits", () => {
  it("commits failed attempts across fresh invite links and blocks the sixth account check", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const away = await seedTournament(db);
    const { user, email: mail } = await seedUser(db, ctx);
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const issued = await withTransaction(ctx, (tx) =>
        createInvite(tx, ctx, {
          organisationId: away.organisationId,
          email: mail,
          role: "organiser",
          invitedBy: away.userId,
        }),
      );
      tokens.push(issued.token);
      const failure = await caught(
        acceptInviteWithSession(
          ctx,
          issued.token,
          { name: "Sample Organiser", password: i === 5 ? PASSWORD : "wrong password" },
          { ip: address(), userAgent: null },
        ),
      );
      expect(failure).toMatchObject({ code: i === 5 ? "rate_limited" : "unauthenticated" });
    }
    const key = windowKey(
      rateLimitKey("organiser-signin", "email", mail),
      RATE_LIMITS.organiserSignInPerEmail,
      T0,
    );
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0]).toMatchObject({
      tokens: 6,
    });
    expect(
      await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, user.id), eq(memberships.organisationId, away.organisationId)),
        ),
    ).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    for (const token of tokens)
      expect((await findLiveInvite(db, token, () => T0)).invite.acceptedAt).toBeNull();
  });

  it("shares the account attempt budget with ordinary organiser sign-in", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const away = await seedTournament(db);
    const { email: mail } = await seedUser(db, ctx);
    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: away.organisationId,
        email: mail,
        role: "organiser",
        invitedBy: away.userId,
      }),
    );
    for (let i = 0; i < 5; i++)
      expect(
        await caught(signIn(ctx, { email: mail, password: "wrong", ip: address() })),
      ).toMatchObject({ code: "unauthenticated" });
    expect(
      await caught(
        acceptInviteWithSession(
          ctx,
          invite.token,
          { name: "Sample Organiser", password: PASSWORD },
          { ip: address(), userAgent: null },
        ),
      ),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("blocks the eleventh check from one trusted address even with different accounts", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const away = await seedTournament(db);
    const sharedIp = address();
    for (let i = 0; i < 11; i++) {
      const { email: mail } = await seedUser(db, ctx);
      const invite = await withTransaction(ctx, (tx) =>
        createInvite(tx, ctx, {
          organisationId: away.organisationId,
          email: mail,
          role: "organiser",
          invitedBy: away.userId,
        }),
      );
      expect(
        await caught(
          acceptInviteWithSession(
            ctx,
            invite.token,
            { name: "Sample Organiser", password: "wrong password" },
            { ip: sharedIp, userAgent: null },
          ),
        ),
      ).toMatchObject({ code: i === 10 ? "rate_limited" : "unauthenticated" });
    }
    const key = windowKey(
      rateLimitKey("organiser-signin", "ip", ipHashOf(sharedIp)),
      RATE_LIMITS.organiserSignInPerIp,
      T0,
    );
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0]).toMatchObject({
      tokens: 11,
    });
  });

  it("accepts the correct password atomically and clears its account failure count", async () => {
    const db = await getDb();
    const ctx = contextAt(db, T0);
    const away = await seedTournament(db);
    const { user, email: mail } = await seedUser(db, ctx);
    const invite = await withTransaction(ctx, (tx) =>
      createInvite(tx, ctx, {
        organisationId: away.organisationId,
        email: mail,
        role: "organiser",
        invitedBy: away.userId,
      }),
    );
    const meta = { ip: address(), userAgent: "Test browser" };
    expect(
      await caught(
        acceptInviteWithSession(
          ctx,
          invite.token,
          { name: "Sample Organiser", password: "wrong password" },
          meta,
        ),
      ),
    ).toMatchObject({ code: "unauthenticated" });
    const accepted = await acceptInviteWithSession(
      ctx,
      invite.token,
      { name: "Sample Organiser", password: PASSWORD },
      meta,
    );
    expect(accepted).toMatchObject({ userId: user.id, organisationId: away.organisationId });
    expect(await resolveUserSession(db, accepted.token, () => T0)).toMatchObject({
      user: { id: user.id },
      memberships: [{ organisationId: away.organisationId }],
    });
    const key = windowKey(
      rateLimitKey("organiser-signin", "email", mail),
      RATE_LIMITS.organiserSignInPerEmail,
      T0,
    );
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, key))).toHaveLength(0);
    expect(await caught(findLiveInvite(db, invite.token, () => T0))).toMatchObject({
      code: "validation",
    });
  });
});
