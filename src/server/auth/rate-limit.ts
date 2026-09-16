/**
 * Fixed-window rate limits in the `rate_limits` table.
 *
 * Each (key, window) pair is one row whose `tokens` column counts attempts.
 * `take` is a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so
 * two serverless instances hitting the same key at the same moment both see
 * the true count; there is no read-then-write race. The window start is
 * part of the stored key, and `sweep` removes rows once their window is
 * long over.
 *
 * Count before you verify, and commit the count whatever happens next: a
 * failed sign-in throws, and an increment inside the same transaction would
 * roll back with it. So `signIn` runs `takeAll` in a transaction of its own
 * and calls `assertAllowed` once that has committed. `enforce` and
 * `enforceAll` are the one-call form for a plain handle (one statement,
 * autocommit); inside a transaction their throw would undo the count.
 */
import { lt } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { rateLimits } from "@/server/db";
import { errors } from "@/server/errors";
import type { Queryable } from "@/server/services";

export interface RateLimitPolicy {
  /** Attempts allowed in one window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts left in this window after this one; never below zero. */
  remaining: number;
  /** Seconds until the window ends; zero when allowed. */
  retryAfterSeconds: number;
}

const FIFTEEN_MINUTES = 15 * 60;
const ONE_HOUR = 60 * 60;

/** The default policies. Keys are built with `rateLimitKey`. */
export const RATE_LIMITS = {
  organiserSignInPerIp: { limit: 10, windowSeconds: FIFTEEN_MINUTES },
  organiserSignInPerEmail: { limit: 5, windowSeconds: FIFTEEN_MINUTES },
  // A tournament venue (and an unproxied self-host) shares one IP bucket.
  judgeSignInPerIp: { limit: 300, windowSeconds: FIFTEEN_MINUTES },
  judgeSignInPerCode: { limit: 5, windowSeconds: FIFTEEN_MINUTES },
  demoCreatePerIp: { limit: 30, windowSeconds: ONE_HOUR },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * A key such as `organiser-signin:email:sam@example.test`. Parts are
 * joined with ":"; pass hashed addresses, not raw ones.
 */
export function rateLimitKey(scope: string, ...parts: string[]): string {
  return [scope, ...parts].join(":");
}

/** The key stored for `key` in the window that contains `now`. */
export function windowKey(key: string, policy: RateLimitPolicy, now: Date): string {
  return `${key}@${windowStartSeconds(policy, now)}`;
}

/** Seconds from `now` until the current window ends (at least one). */
export function secondsUntilWindowEnds(policy: RateLimitPolicy, now: Date): number {
  const end = windowStartSeconds(policy, now) + policy.windowSeconds;
  return Math.max(1, Math.ceil(end - now.getTime() / 1000));
}

/**
 * Records one attempt against `key` and says whether it was within the
 * limit. Atomic: safe to call from many instances at once.
 */
export async function take(
  db: Queryable,
  key: string,
  policy: RateLimitPolicy,
  now: () => Date = () => new Date(),
): Promise<RateLimitDecision> {
  const at = now();
  const [row] = await db
    .insert(rateLimits)
    .values({ key: windowKey(key, policy, at), tokens: 1, updatedAt: at })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: { tokens: sql`${rateLimits.tokens} + 1`, updatedAt: at },
    })
    .returning({ tokens: rateLimits.tokens });

  const used = Number(row.tokens);
  const allowed = used <= policy.limit;
  return {
    allowed,
    remaining: Math.max(0, policy.limit - used),
    retryAfterSeconds: allowed ? 0 : secondsUntilWindowEnds(policy, at),
  };
}

/** One key and the policy it is judged by. */
export interface RateLimitCheck {
  key: string;
  policy: RateLimitPolicy;
}

/**
 * Takes one attempt from each limit and returns every decision. All are
 * counted before any is judged, so a burst is charged against every limit
 * it touched. Judge the result with `assertAllowed` after the transaction
 * that ran this has committed.
 */
export async function takeAll(
  db: Queryable,
  checks: RateLimitCheck[],
  now: () => Date = () => new Date(),
): Promise<RateLimitDecision[]> {
  const decisions: RateLimitDecision[] = [];
  for (const { key, policy } of checks) decisions.push(await take(db, key, policy, now));
  return decisions;
}

/** Throws `errors.rateLimited` with the longest wait when any decision blocked. */
export function assertAllowed(decisions: RateLimitDecision[]): void {
  const blocked = decisions.filter((decision) => !decision.allowed);
  if (blocked.length > 0) {
    throw errors.rateLimited(Math.max(...blocked.map((d) => d.retryAfterSeconds)));
  }
}

/**
 * `take` then `assertAllowed`, for a plain (autocommit) handle. Inside a
 * transaction, use `takeAll` and judge after the commit; see the header.
 */
export async function enforce(
  db: Queryable,
  key: string,
  policy: RateLimitPolicy,
  now: () => Date = () => new Date(),
): Promise<RateLimitDecision> {
  const decision = await take(db, key, policy, now);
  assertAllowed([decision]);
  return decision;
}

/** `takeAll` then `assertAllowed`, for a plain (autocommit) handle. */
export async function enforceAll(
  db: Queryable,
  checks: RateLimitCheck[],
  now: () => Date = () => new Date(),
): Promise<RateLimitDecision[]> {
  const decisions = await takeAll(db, checks, now);
  assertAllowed(decisions);
  return decisions;
}

/** Deletes rows last touched before `olderThan`. Returns how many went. */
export async function sweep(db: Queryable, olderThan: Date): Promise<number> {
  const gone = await db
    .delete(rateLimits)
    .where(lt(rateLimits.updatedAt, olderThan))
    .returning({ key: rateLimits.key });
  return gone.length;
}

function windowStartSeconds(policy: RateLimitPolicy, now: Date): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return seconds - (seconds % policy.windowSeconds);
}
