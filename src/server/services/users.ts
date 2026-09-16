/**
 * Organiser accounts: first-run sign-up, sign-in, passwords and sessions.
 *
 * Sign-up is open only until the first organisation exists; after that,
 * people join by invite (`acceptInvite` in the auth layer) or through the
 * CLI. Sign-in counts every attempt against two rate limits (per address
 * and per email) in a transaction of its own, so a failed attempt is still
 * counted when the sign-in transaction rolls back, and it verifies against
 * a dummy hash when the email is unknown so both outcomes take one scrypt.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  organisations,
  sessions,
  users,
  type MembershipRow,
  type OrganisationRow,
  type SessionRow,
  type UserRow,
} from "@/server/db";
import { rateLimits } from "@/server/db";
import { errors } from "@/server/errors";
import { AUTH_AUDIT_ACTIONS, recordAuthAudit } from "@/server/auth/audit-actions";
import {
  dummyPasswordHash,
  hashPassword,
  passwordIssue,
  verifyPassword,
} from "@/server/auth/password";
import {
  RATE_LIMITS,
  assertAllowed,
  rateLimitKey,
  takeAll,
  windowKey,
} from "@/server/auth/rate-limit";
import { ipHashOf } from "@/server/auth/request-meta";
import {
  createUserSession,
  isSessionLive,
  revokeAllUserSessions,
  type IssuedSession,
} from "@/server/auth/session";
import {
  createUser,
  ensureMembership,
  findUserByEmail,
  normaliseEmail,
} from "@/server/auth/tokens";

import { isUniqueViolation, withTransaction, type Queryable, type ServiceContext } from "./context";

/** The one message for every failed sign-in; it never says which part was wrong. */
const SIGN_IN_FAILED = "That email and password don't match. Check them and try again.";

export interface SignUpFirstOwnerInput {
  orgName: string;
  email: string;
  name: string;
  password: string;
}

export interface SignedUp {
  user: UserRow;
  organisation: OrganisationRow;
  membership: MembershipRow;
}

export interface SignInInput {
  email: string;
  password: string;
  /** The client address, hashed before use; null when unknown. */
  ip?: string | null;
  userAgent?: string | null;
}

export interface SignedIn extends IssuedSession {
  user: UserRow;
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  /** The session to keep signed in, usually the one making the change. */
  keepSessionId?: string;
}

export interface CreateUserByCliInput {
  email: string;
  name: string;
  password: string;
  /** Organisation to join, by slug or name; created when it does not exist. */
  orgName?: string;
  owner?: boolean;
}

/** A session as the "signed-in devices" list shows it: no hashes. */
export type SessionSummary = Pick<
  SessionRow,
  "id" | "createdAt" | "lastSeenAt" | "expiresAt" | "userAgent"
>;

/** Only an unclaimed instance may take this lock; see `signUpFirstOwner`. */
const FIRST_OWNER_LOCK = "dais:first-owner";

/**
 * Creates the first organisation and its owner. Refused once any
 * organisation exists. The advisory lock makes two simultaneous first
 * sign-ups queue, so the second sees the first's organisation and is
 * refused rather than both succeeding.
 */
export async function signUpFirstOwner(
  tx: Queryable,
  ctx: ServiceContext,
  input: SignUpFirstOwnerInput,
): Promise<SignedUp> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${FIRST_OWNER_LOCK}))`);
  const [existing] = await tx.select({ id: organisations.id }).from(organisations).where(eq(organisations.isDemo, false)).limit(1);
  if (existing) {
    throw errors.forbidden(
      "Dais already has an organisation. Ask its owner for an invite link to join.",
    );
  }

  const orgName = input.orgName.trim();
  const name = input.name.trim();
  if (orgName.length === 0 || name.length === 0) {
    throw errors.validation("Enter the organisation's name and your name.");
  }

  const user = await createUser(tx, ctx, input.email, name, input.password);
  const asUser = { ...ctx, actor: { type: "user" as const, id: user.id, name: user.name } };
  const organisation = await createOrganisation(tx, asUser, orgName);
  const membership = await ensureMembership(tx, organisation.id, user.id, "owner", ctx.now());
  return { user, organisation, membership };
}

/**
 * Signs an organiser in and returns the session token for the cookie.
 * Throws `rate_limited` when either limit is exceeded and `unauthenticated`
 * with one fixed message for every other failure.
 */
export async function signIn(ctx: ServiceContext, input: SignInInput): Promise<SignedIn> {
  const email = normaliseEmail(input.email);
  const ipHash = ipHashOf(input.ip);

  // Counted in a transaction of its own, then judged after it has committed:
  // a throw inside `withTransaction` would roll the count back.
  const decisions = await withTransaction(ctx, (tx) =>
    takeAll(
      tx,
      [
        {
          key: rateLimitKey("organiser-signin", "ip", ipHash),
          policy: RATE_LIMITS.organiserSignInPerIp,
        },
        {
          key: rateLimitKey("organiser-signin", "email", email),
          policy: RATE_LIMITS.organiserSignInPerEmail,
        },
      ],
      ctx.now,
    ),
  );
  assertAllowed(decisions);

  return withTransaction(ctx, async (tx) => {
    const user = await findUserByEmail(tx, email);
    const stored = user?.passwordHash ?? (await dummyPasswordHash());
    const matches = await verifyPassword(input.password, stored);
    if (!user || !user.passwordHash || !matches) throw errors.unauthenticated(SIGN_IN_FAILED);

    await tx.delete(rateLimits).where(
      eq(
        rateLimits.key,
        windowKey(
          rateLimitKey("organiser-signin", "email", email),
          RATE_LIMITS.organiserSignInPerEmail,
          ctx.now(),
        ),
      ),
    );

    const asUser = { ...ctx, actor: { type: "user" as const, id: user.id, name: user.name } };
    const issued = await createUserSession(tx, asUser, user.id, {
      userAgent: input.userAgent ?? null,
      ipHash,
    });
    await tx.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, user.id));
    return { ...issued, user };
  });
}

/**
 * Changes a password after checking the current one, and signs out every
 * other device. The reason on those sessions is fixed text, since the
 * change itself is the reason.
 */
export async function changePassword(
  tx: Queryable,
  ctx: ServiceContext,
  input: ChangePasswordInput,
): Promise<void> {
  const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) throw errors.notFound("That account");
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw errors.validation("The current password is not right.", {
      issues: [{ path: "currentPassword", message: "The current password is not right." }],
    });
  }
  await setPassword(tx, ctx, user, input.newPassword);
  await revokeAllUserSessions(tx, ctx, user.id, "password changed", {
    except: input.keepSessionId,
  });
  await recordAuthAudit(tx, ctx, {
    action: AUTH_AUDIT_ACTIONS.userPasswordChanged,
    entityType: "user",
    entityId: user.id,
  });
}

/**
 * Sets a new password from the command line (`pnpm cli users:reset-password`)
 * and signs the user out everywhere. Returns the user for the CLI to name.
 */
export async function resetPasswordByCli(
  tx: Queryable,
  ctx: ServiceContext,
  email: string,
  newPassword: string,
): Promise<UserRow> {
  const user = await findUserByEmail(tx, email);
  if (!user) throw errors.notFound("An account with that email");
  await setPassword(tx, ctx, user, newPassword);
  await revokeAllUserSessions(tx, ctx, user.id, "password reset from the command line");
  await recordAuthAudit(tx, ctx, {
    action: AUTH_AUDIT_ACTIONS.userPasswordReset,
    entityType: "user",
    entityId: user.id,
  });
  return user;
}

/** The user's live sessions, newest first, without token or address hashes. */
export async function listSessions(
  db: Queryable,
  userId: string,
  now: () => Date = () => new Date(),
): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.createdAt));
  const at = now();
  return rows
    .filter((row) => isSessionLive(row, at))
    .map(({ id, createdAt, lastSeenAt, expiresAt, userAgent }) => ({
      id,
      createdAt,
      lastSeenAt,
      expiresAt,
      userAgent,
    }));
}

/** "Sign out everywhere": revokes every live session of the user. */
export async function signOutEverywhere(
  tx: Queryable,
  ctx: ServiceContext,
  userId: string,
  reason = "signed out everywhere",
): Promise<number> {
  return revokeAllUserSessions(tx, ctx, userId, reason);
}

/**
 * Creates an account from the command line, joining (or creating) an
 * organisation when one is named. With no name and exactly one
 * organisation, that one is used; otherwise the caller must choose.
 */
export async function createUserByCli(
  tx: Queryable,
  ctx: ServiceContext,
  input: CreateUserByCliInput,
): Promise<{
  user: UserRow;
  organisation: OrganisationRow | null;
  membership: MembershipRow | null;
}> {
  const user = await createUser(tx, ctx, input.email, input.name, input.password);
  const organisation = await chooseOrganisation(tx, ctx, input.orgName);
  if (!organisation) return { user, organisation: null, membership: null };
  const role = input.owner ? "owner" : "organiser";
  const membership = await ensureMembership(tx, organisation.id, user.id, role, ctx.now());
  return { user, organisation, membership };
}

/** Lower-case letters, digits and single hyphens; "organisation" when nothing is left. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "organisation";
}

async function setPassword(
  tx: Queryable,
  ctx: ServiceContext,
  user: UserRow,
  newPassword: string,
): Promise<void> {
  const issue = passwordIssue(newPassword);
  if (issue) throw errors.validation(issue, { issues: [{ path: "newPassword", message: issue }] });
  await tx
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: ctx.now() })
    .where(eq(users.id, user.id));
}

/** Inserts an organisation, adding a numeric suffix to the slug on a clash. */
async function createOrganisation(
  tx: Queryable,
  ctx: ServiceContext,
  name: string,
): Promise<OrganisationRow> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const [organisation] = await tx
        .insert(organisations)
        .values({ slug, name, createdAt: ctx.now(), updatedAt: ctx.now() })
        .returning();
      await recordAuthAudit(tx, ctx, {
        action: AUTH_AUDIT_ACTIONS.organisationCreated,
        entityType: "organisation",
        entityId: organisation.id,
        after: { name, slug },
      });
      return organisation;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A Postgres transaction is aborted after any error; a savepoint would
      // be needed to continue. Five slug clashes in a row is not a real case.
      if (attempt === 4) throw errors.validation("An organisation with that name already exists.");
    }
  }
  throw errors.internal();
}

/**
 * The organisation named by slug or name (case-insensitive), created when
 * missing; or the only organisation when none is named; or null when there
 * are none. Throws when several exist and none was named.
 */
async function chooseOrganisation(
  tx: Queryable,
  ctx: ServiceContext,
  orgName: string | undefined,
): Promise<OrganisationRow | null> {
  const name = orgName?.trim();
  if (name) {
    const [found] = await tx
      .select()
      .from(organisations)
      .where(
        sql`lower(${organisations.name}) = ${name.toLowerCase()} or ${organisations.slug} = ${slugify(name)}`,
      )
      .limit(1);
    return found ?? createOrganisation(tx, ctx, name);
  }
  const all = await tx.select().from(organisations).orderBy(organisations.createdAt).limit(2);
  if (all.length === 0) return null;
  if (all.length > 1) {
    throw errors.validation("Several organisations exist. Name one with --org.");
  }
  return all[0];
}
