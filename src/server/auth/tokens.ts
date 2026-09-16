/**
 * The two link-borne secrets: a judge's join token (the QR code on their
 * card) and an organiser invite.
 *
 * Join tokens are derived, not random: `HMAC(SESSION_SECRET, judgeId,
 * session_epoch)`. The database still stores only `hashToken(token)` in
 * `judges.join_token_hash`, so a copy of the database alone cannot be used
 * to join, and the token can be shown again whenever the organiser prints
 * the cards. Bumping `session_epoch` (`revokeJudgeSessions`) rotates the
 * token as a side effect, which is what "lost phone" needs: one action
 * signs the old device out and makes a new card. `issueJoinToken` stores
 * the hash for the judge's current epoch and returns the plaintext.
 *
 * Invites are random, single use, and expire after seven days. Accepting
 * one creates the user and the membership in one transaction.
 */
import { createHmac } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  invites,
  judges,
  memberships,
  organisations,
  users,
  type InviteRow,
  type JudgeRow,
  type MembershipRow,
  type OrganisationRow,
  type UserRow,
} from "@/server/db";
import { getEnv } from "@/server/env";
import { errors } from "@/server/errors";
import {
  hashToken,
  isUniqueViolation,
  randomToken,
  type Queryable,
  type ServiceContext,
} from "@/server/services";

import { AUTH_AUDIT_ACTIONS, recordAuthAudit } from "./audit-actions";
import { hashPassword, passwordIssue, verifyPassword } from "./password";

const SIGN_IN_FAILED = "That email and password don't match. Check them and try again.";

/** How long an invite link works. */
export const INVITE_TTL_DAYS = 7;

/** Bytes of HMAC output kept in a join token; 24 bytes is 32 characters. */
const JOIN_TOKEN_BYTES = 24;

type JoinTokenSource = Pick<JudgeRow, "id" | "sessionEpoch">;

// ---------------------------------------------------------------------------
// Judge join tokens
// ---------------------------------------------------------------------------

/** The join token for a judge at their current epoch. Deterministic; see the header. */
export function joinTokenFor(judge: JoinTokenSource): string {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(`dais-join:${judge.id}:${judge.sessionEpoch}`)
    .digest()
    .subarray(0, JOIN_TOKEN_BYTES)
    .toString("base64url");
}

/** The value to store in `judges.join_token_hash` for a judge. */
export function joinTokenHashFor(judge: JoinTokenSource): string {
  return hashToken(joinTokenFor(judge));
}

/** The link a judge's QR code opens. */
export function joinLinkFor(token: string): string {
  return new URL(`/j/join?t=${encodeURIComponent(token)}`, getEnv().APP_URL).toString();
}

/**
 * Stores the hash of the judge's current join token and returns the
 * plaintext for the card or QR code. Safe to call again: the result is the
 * same until the epoch changes.
 */
export async function issueJoinToken(
  tx: Queryable,
  ctx: ServiceContext,
  judgeId: string,
): Promise<string> {
  const [judge] = await tx.select().from(judges).where(eq(judges.id, judgeId)).limit(1);
  if (!judge) throw errors.notFound("That judge");
  const token = joinTokenFor(judge);
  const tokenHash = hashToken(token);
  if (judge.joinTokenHash !== tokenHash) {
    await tx
      .update(judges)
      .set({ joinTokenHash: tokenHash, updatedAt: ctx.now() })
      .where(eq(judges.id, judgeId));
  }
  return token;
}

/**
 * The active judge a join token belongs to, or null. A withdrawn judge's
 * token is treated as unknown so a replaced judge cannot rejoin.
 */
export async function verifyJoinToken(db: Queryable, token: string): Promise<JudgeRow | null> {
  if (!token) return null;
  const [judge] = await db
    .select()
    .from(judges)
    .where(eq(judges.joinTokenHash, hashToken(token)))
    .limit(1);
  if (!judge || judge.status !== "active") return null;
  // A hash written before an epoch bump would still match its old token;
  // comparing against the current epoch makes rotation immediate.
  return judge.joinTokenHash === joinTokenHashFor(judge) ? judge : null;
}

// ---------------------------------------------------------------------------
// Organiser invites
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  organisationId: string;
  email: string;
  role: InviteRow["role"];
  /** The inviting user's id; null for the CLI. */
  invitedBy: string | null;
  ttlDays?: number;
}

export interface IssuedInvite {
  token: string;
  inviteId: string;
  expiresAt: Date;
}

export interface AcceptInviteInput {
  name: string;
  password: string;
}

export interface AcceptedInvite {
  user: UserRow;
  membership: MembershipRow;
  organisation: OrganisationRow;
  /** True when the email already had an account; its password is unchanged. */
  existingUser: boolean;
}

/** The link an invite email or message carries. */
export function inviteLinkFor(token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, getEnv().APP_URL).toString();
}

/** Creates a single-use invite and returns the token for the link. */
export async function createInvite(
  tx: Queryable,
  ctx: ServiceContext,
  input: CreateInviteInput,
): Promise<IssuedInvite> {
  const [organisation] = await tx
    .select({ id: organisations.id, isDemo: organisations.isDemo })
    .from(organisations)
    .where(eq(organisations.id, input.organisationId))
    .limit(1);
  if (!organisation) throw errors.notFound("That organisation");
  if (organisation.isDemo) throw errors.forbidden("Invites are not available in the temporary public demo.");

  const token = randomToken();
  const now = ctx.now();
  const ttlDays = input.ttlDays ?? INVITE_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const [invite] = await tx
    .insert(invites)
    .values({
      organisationId: input.organisationId,
      email: normaliseEmail(input.email),
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: input.invitedBy,
      createdAt: now,
      expiresAt,
    })
    .returning({ id: invites.id });

  await recordAuthAudit(tx, ctx, {
    action: AUTH_AUDIT_ACTIONS.inviteCreated,
    entityType: "invite",
    entityId: invite.id,
    after: { organisationId: input.organisationId, role: input.role, expiresAt },
  });
  return { token, inviteId: invite.id, expiresAt };
}

/**
 * The invite behind a token, with its organisation, when it can still be
 * accepted. The accept page uses it to show "Join Sample Debating Society".
 * Throws a plain-English validation error otherwise.
 */
export async function findLiveInvite(
  db: Queryable,
  token: string,
  now: () => Date = () => new Date(),
): Promise<{ invite: InviteRow; organisation: OrganisationRow }> {
  const [found] = token
    ? await db
        .select({ invite: invites, organisation: organisations })
        .from(invites)
        .innerJoin(organisations, eq(organisations.id, invites.organisationId))
        .where(eq(invites.tokenHash, hashToken(token)))
        .limit(1)
    : [];
  if (!found || found.invite.revokedAt) {
    throw errors.validation("This invite link is not valid. Ask the organiser for a new one.");
  }
  if (found.invite.acceptedAt) {
    throw errors.validation("This invite link has already been used. Sign in instead.");
  }
  if (found.invite.expiresAt.getTime() <= now().getTime()) {
    throw errors.validation("This invite link has expired. Ask the organiser for a new one.");
  }
  return found;
}

/**
 * Accepts an invite: creates the user (or, when the email already has an
 * account, leaves it as it is) and the membership, and marks the invite
 * used. Single use is enforced with a conditional update, so two accepts
 * of one link in the same instant cannot both succeed.
 * Request handlers use acceptInviteWithSession, which commits password
 * attempt limits before calling this transaction primitive.
 */
export async function acceptInvite(
  tx: Queryable,
  ctx: ServiceContext,
  token: string,
  input: AcceptInviteInput,
): Promise<AcceptedInvite> {
  const { invite, organisation } = await findLiveInvite(tx, token, ctx.now);
  const name = input.name.trim();
  if (name.length === 0) {
    throw errors.validation("Enter your name.", {
      issues: [{ path: "name", message: "Your name is required." }],
    });
  }

  const existing = await findUserByEmail(tx, invite.email);
  if (existing) {
    const valid = existing.passwordHash
      ? await verifyPassword(input.password, existing.passwordHash)
      : false;
    if (!valid) throw errors.unauthenticated(SIGN_IN_FAILED);
  }

  // Claim before touching users or memberships so concurrent acceptors have
  // one clear winner and the loser gets the used-link error.
  const claimed = await tx
    .update(invites)
    .set({ acceptedAt: ctx.now() })
    .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id });
  if (claimed.length === 0) {
    throw errors.validation("This invite link has already been used. Sign in instead.");
  }

  const user = existing ?? (await createUser(tx, ctx, invite.email, name, input.password));
  const membership = await ensureMembership(tx, organisation.id, user.id, invite.role, ctx.now());
  await tx.update(invites).set({ acceptedBy: user.id }).where(eq(invites.id, invite.id));

  await recordAuthAudit(
    tx,
    { ...ctx, actor: { type: "user", id: user.id, name: user.name } },
    {
      action: AUTH_AUDIT_ACTIONS.inviteAccepted,
      entityType: "invite",
      entityId: invite.id,
      after: {
        organisationId: organisation.id,
        role: invite.role,
        existingUser: Boolean(existing),
      },
    },
  );
  return { user, membership, organisation, existingUser: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// Users and memberships (shared with the users service)
// ---------------------------------------------------------------------------

/** Lower-cased and trimmed; the unique index on `users` is on `lower(email)`. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normaliseEmail(email)}`)
    .limit(1);
  return user ?? null;
}

/**
 * Inserts a user with a hashed password. Throws a plain validation error
 * for a weak password or an email that is already taken.
 */
export async function createUser(
  tx: Queryable,
  ctx: ServiceContext,
  email: string,
  name: string,
  password: string,
): Promise<UserRow> {
  const issue = passwordIssue(password);
  if (issue) {
    throw errors.validation(issue, { issues: [{ path: "password", message: issue }] });
  }
  const now = ctx.now();
  try {
    const [user] = await tx
      .insert(users)
      .values({
        email: normaliseEmail(email),
        name: name.trim(),
        passwordHash: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await recordAuthAudit(tx, ctx, {
      action: AUTH_AUDIT_ACTIONS.userCreated,
      entityType: "user",
      entityId: user.id,
    });
    return user;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw errors.validation("An account with this email already exists. Sign in instead.", {
        issues: [{ path: "email", message: "This email already has an account." }],
      });
    }
    throw error;
  }
}

/** Adds a membership, or returns the existing one unchanged. */
export async function ensureMembership(
  tx: Queryable,
  organisationId: string,
  userId: string,
  role: MembershipRow["role"],
  now: Date,
): Promise<MembershipRow> {
  const [existing] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)))
    .limit(1);
  if (existing) return existing;
  const [membership] = await tx
    .insert(memberships)
    .values({ organisationId, userId, role, createdAt: now })
    .returning();
  return membership;
}
