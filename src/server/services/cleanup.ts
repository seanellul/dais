/**
 * Housekeeping: expired demos, stale sessions, old rate-limit buckets and
 * silent judge devices.
 *
 * A per-visitor demo is a throwaway organisation with one demo tournament
 * whose `demo_expires_at` is set at creation (see `demo.ts`). Expiry lives
 * on the tournament because organisations have no expiry column. When the
 * tournament goes, the organisation follows if it is a throwaway one (slug
 * prefix `demo-`) with nothing else in it, and so does its synthetic
 * organiser (address in `demo.invalid`) when no other membership remains.
 *
 * `cleanupExpired` is what the cron route calls. `lazySweep` runs it from
 * organiser page loads at most every ten minutes per process, so a
 * self-hosted install without cron still tidies itself.
 */
import { and, eq, isNotNull, like, lt, lte, or, sql } from "drizzle-orm";

import {
  invites,
  judgeDevices,
  memberships,
  organisations,
  rateLimits,
  sessions,
  tournaments,
  users,
  type Tx,
} from "@/server/db";

import { withTransaction, type ServiceContext } from "./context";
import { DEMO_USER_EMAIL_DOMAIN } from "./demo";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Expired or revoked sessions are kept this long for the audit of "who was signed in". */
export const SESSION_RETENTION_MS = 7 * DAY_MS;
/** Rate-limit buckets refill within minutes; a day-old row is dead weight. */
export const RATE_LIMIT_RETENTION_MS = DAY_MS;
/** A judge's phone not seen for this long is forgotten by the live board. */
export const JUDGE_DEVICE_RETENTION_MS = 30 * DAY_MS;
/** The least time between two lazy sweeps in one process. */
export const LAZY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface CleanupCounts {
  demoTournaments: number;
  demoOrganisations: number;
  demoUsers: number;
  sessions: number;
  rateLimits: number;
  judgeDevices: number;
}

/** Removes everything past its time as of `now` (defaults to the context clock). */
export async function cleanupExpired(
  ctx: ServiceContext,
  now: Date = ctx.now(),
): Promise<CleanupCounts> {
  const demo = await withTransaction(ctx, (tx) => removeExpiredDemos(tx, ctx, now));
  const rest = await withTransaction(ctx, async (tx) => ({
    sessions: await removeStaleSessions(tx, now),
    rateLimits: await removeStaleRateLimits(tx, now),
    judgeDevices: await removeSilentDevices(tx, now),
  }));
  const counts = { ...demo, ...rest };
  ctx.log.info(counts, "Cleanup sweep finished");
  return counts;
}

/**
 * Deletes every demo tournament past its expiry (its rows cascade), then
 * each throwaway organisation left empty and each synthetic organiser left
 * without a membership.
 *
 * Each organisation, and each organiser, is removed in its own savepoint.
 * After a failed statement Postgres aborts the whole transaction, so
 * without one a single bad row (a synthetic organiser still named by an
 * invite in another organisation, say) would undo the tournament deletes
 * as well, while the counts claimed the sweep had worked. A failure is
 * logged and the sweep carries on; the counts cover only what went.
 */
async function removeExpiredDemos(
  tx: Tx,
  ctx: ServiceContext,
  now: Date,
): Promise<Pick<CleanupCounts, "demoTournaments" | "demoOrganisations" | "demoUsers">> {
  const expired = await tx
    .delete(tournaments)
    .where(
      and(
        eq(tournaments.kind, "demo"),
        isNotNull(tournaments.demoExpiresAt),
        lte(tournaments.demoExpiresAt, now),
      ),
    )
    .returning({ id: tournaments.id, organisationId: tournaments.organisationId });

  let demoOrganisations = 0;
  let demoUsers = 0;
  for (const organisationId of new Set(expired.map((row) => row.organisationId))) {
    const removed = await attempt(tx, ctx, { organisationId }, (sp) =>
      removeThrowawayOrganisation(sp, organisationId),
    );
    if (!removed) continue;
    demoOrganisations += removed.organisations;
    for (const userId of removed.formerMembers) {
      const gone = await attempt(tx, ctx, { organisationId, userId }, (sp) =>
        removeSyntheticUser(sp, userId),
      );
      demoUsers += gone ?? 0;
    }
  }
  return { demoTournaments: expired.length, demoOrganisations, demoUsers };
}

/**
 * Runs `work` in a savepoint and returns its result, or `undefined` after
 * logging the failure, so the enclosing transaction stays usable and only
 * this piece of the sweep is rolled back.
 */
async function attempt<T>(
  tx: Tx,
  ctx: ServiceContext,
  about: Record<string, string>,
  work: (savepoint: Tx) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await tx.transaction(work);
  } catch (error) {
    ctx.log.warn({ err: error, ...about }, "Could not remove part of an expired demo");
    return undefined;
  }
}

/**
 * Removes an organisation when it is a throwaway demo one with no
 * tournaments left, together with its memberships, invites and sessions,
 * and returns the users who were its members so the caller can try each.
 */
async function removeThrowawayOrganisation(
  tx: Tx,
  organisationId: string,
): Promise<{ organisations: number; formerMembers: string[] }> {
  const nothing = { organisations: 0, formerMembers: [] };
  const [organisation] = await tx
    .select({ id: organisations.id, isDemo: organisations.isDemo })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!organisation?.isDemo) return nothing;
  const [remaining] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tournaments)
    .where(eq(tournaments.organisationId, organisationId));
  if ((remaining?.count ?? 0) > 0) return nothing;

  const members = await tx
    .delete(memberships)
    .where(eq(memberships.organisationId, organisationId))
    .returning({ userId: memberships.userId });
  await tx.delete(invites).where(eq(invites.organisationId, organisationId));
  await tx.delete(sessions).where(eq(sessions.organisationId, organisationId));
  await tx.delete(organisations).where(eq(organisations.id, organisationId));
  return { organisations: 1, formerMembers: members.map((member) => member.userId) };
}

/**
 * Deletes the user when they are a synthetic organiser with no membership
 * left, with their sessions. Returns how many users went (0 or 1).
 */
async function removeSyntheticUser(tx: Tx, userId: string): Promise<number> {
  const [membership] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (membership) return 0;
  const [synthetic] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), like(users.email, `%@${DEMO_USER_EMAIL_DOMAIN}`)))
    .limit(1);
  if (!synthetic) return 0;
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  const removed = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  return removed.length;
}

async function removeStaleSessions(tx: Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
  const removed = await tx
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });
  return removed.length;
}

async function removeStaleRateLimits(tx: Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS);
  const removed = await tx
    .delete(rateLimits)
    .where(lt(rateLimits.updatedAt, cutoff))
    .returning({ key: rateLimits.key });
  return removed.length;
}

async function removeSilentDevices(tx: Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - JUDGE_DEVICE_RETENTION_MS);
  const removed = await tx
    .delete(judgeDevices)
    .where(lt(judgeDevices.lastSeenAt, cutoff))
    .returning({ id: judgeDevices.id });
  return removed.length;
}

// ---------------------------------------------------------------------------
// Lazy sweep
// ---------------------------------------------------------------------------

/** When the last sweep started in this process, as epoch milliseconds. */
let lastSweepStartedAt: number | undefined;

/**
 * Runs `cleanupExpired` unless one ran in the last ten minutes. The stamp
 * is set before the sweep starts, so concurrent page loads skip rather
 * than sweep twice. Never throws: a failed sweep is logged and the page
 * that triggered it renders as normal. Returns the counts, or null when
 * nothing ran.
 */
export async function lazySweep(ctx: ServiceContext): Promise<CleanupCounts | null> {
  const now = ctx.now().getTime();
  if (lastSweepStartedAt !== undefined && now - lastSweepStartedAt < LAZY_SWEEP_INTERVAL_MS) {
    return null;
  }
  lastSweepStartedAt = now;
  try {
    return await cleanupExpired(ctx, new Date(now));
  } catch (error) {
    ctx.log.warn({ err: error }, "Lazy cleanup sweep failed");
    return null;
  }
}

/** Forgets the last sweep time so the next `lazySweep` runs. For tests. */
export function resetLazySweep(): void {
  lastSweepStartedAt = undefined;
}
