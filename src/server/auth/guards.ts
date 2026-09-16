/**
 * Request-scoped guards for Server Components, Server Actions and route
 * handlers. Server only: this module reads `cookies()`.
 *
 * `getCurrentUser` and `getCurrentJudge` are wrapped in React's `cache`, so
 * a layout, a page and an action in the same request share one database
 * lookup. The `require*` functions throw `errors.unauthenticated` (no
 * usable session) or `errors.forbidden` (a session, but no membership),
 * which the action's `run` turns into `{ ok: false, error }`.
 *
 * Membership roles are `owner` and `organiser`; both may run a tournament.
 * `requireViewer` exists for read-only pages and today accepts the same
 * roles, so a future read-only role changes one function.
 */
import { and, eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";

import {
  getDb,
  tournaments,
  type JudgeRow,
  type MembershipRow,
  type SessionRow,
  type TournamentRow,
  type UserRow,
} from "@/server/db";
import { errors } from "@/server/errors";
import type { Actor } from "@/server/services";

import { JUDGE_COOKIE, resolveJudgeSession, type ResolvedJudgeSession } from "./judge-session";
import { ORGANISER_COOKIE, resolveUserSession, type ResolvedUserSession } from "./session";

export interface OrganiserAccess {
  user: UserRow;
  session: SessionRow;
  membership: MembershipRow;
  tournament: TournamentRow;
}

/** Roles that may change a tournament. */
const ORGANISER_ROLES: ReadonlySet<MembershipRow["role"]> = new Set(["owner", "organiser"]);
/** Roles that may read a tournament. */
const VIEWER_ROLES: ReadonlySet<MembershipRow["role"]> = new Set(["owner", "organiser"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in organiser for this request, or null. One lookup per request. */
export const getCurrentUser = cache(async (): Promise<ResolvedUserSession | null> => {
  const token = (await cookies()).get(ORGANISER_COOKIE)?.value;
  if (!token) return null;
  return resolveUserSession(await getDb(), token);
});

/** The signed-in judge for this request, or null. One lookup per request. */
export const getCurrentJudge = cache(async (): Promise<ResolvedJudgeSession | null> => {
  const token = (await cookies()).get(JUDGE_COOKIE)?.value;
  if (!token) return null;
  return resolveJudgeSession(await getDb(), token);
});

/** The signed-in organiser, or `unauthenticated`. */
export async function requireUser(): Promise<ResolvedUserSession> {
  const current = await getCurrentUser();
  if (!current) throw errors.unauthenticated();
  return current;
}

/** The signed-in organiser with a membership that may change `tournamentId`. */
export async function requireOrganiser(tournamentId: string): Promise<OrganiserAccess> {
  return accessTo(await findTournamentById(tournamentId), ORGANISER_ROLES);
}

/** The signed-in organiser with a membership that may read `tournamentId`. */
export async function requireViewer(tournamentId: string): Promise<OrganiserAccess> {
  return accessTo(await findTournamentById(tournamentId), VIEWER_ROLES);
}

/**
 * `requireOrganiser` for routes that carry the tournament slug. Slugs are
 * unique per organisation, so the match is made among the organisations
 * the user belongs to.
 */
export async function requireOrganiserBySlug(slug: string): Promise<OrganiserAccess> {
  const current = await requireUser();
  const organisationIds = current.memberships.map((membership) => membership.organisationId);
  if (organisationIds.length === 0) throw errors.forbidden();
  const db = await getDb();
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), inArray(tournaments.organisationId, organisationIds)))
    .limit(1);
  return accessTo(tournament ?? null, ORGANISER_ROLES);
}

/** The signed-in judge, or `unauthenticated`. */
export async function requireJudge(): Promise<ResolvedJudgeSession> {
  const current = await getCurrentJudge();
  if (!current) {
    throw errors.unauthenticated("Sign in with your judge code or QR card to continue.");
  }
  return current;
}

/** The `Actor` a service context should carry for a signed-in organiser. */
export function actorForUser(user: Pick<UserRow, "id" | "name">): Actor {
  return { type: "user", id: user.id, name: user.name };
}

/** The `Actor` a service context should carry for a signed-in judge. */
export function actorForJudge(judge: Pick<JudgeRow, "id" | "name">): Actor {
  return { type: "judge", id: judge.id, name: judge.name };
}

async function findTournamentById(tournamentId: string): Promise<TournamentRow | null> {
  // A non-uuid would make Postgres raise a cast error; treat it as unknown.
  if (!UUID_PATTERN.test(tournamentId)) return null;
  const db = await getDb();
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  return tournament ?? null;
}

/**
 * Checks the current user against a tournament's organisation. The session
 * check comes first so a signed-out user gets 401 even for a tournament
 * that does not exist.
 */
async function accessTo(
  tournament: TournamentRow | null,
  roles: ReadonlySet<MembershipRow["role"]>,
): Promise<OrganiserAccess> {
  const current = await requireUser();
  if (!tournament) throw errors.notFound("That tournament");
  if (tournament.demoExpiresAt && tournament.demoExpiresAt <= new Date()) throw errors.notFound("This expired demo");
  const membership = current.memberships.find(
    (row) => row.organisationId === tournament.organisationId && roles.has(row.role),
  );
  if (!membership) throw errors.forbidden();
  return { user: current.user, session: current.session, membership, tournament };
}
