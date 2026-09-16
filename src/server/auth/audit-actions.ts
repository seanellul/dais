/**
 * Audit actions for account and session events, and a writer for the ones
 * that belong to no tournament.
 *
 * `recordAudit` in the services layer needs a tournament id, because every
 * organiser change to a tournament is scoped. Accounts, invites and
 * organiser sessions live above tournaments, so their rows are written here
 * with `tournament_id` null. Judge session revocations are tournament-scoped
 * and go through `recordAudit` with `AUDIT_ACTIONS.judgesSessionsRevoked`.
 */
import { auditLog } from "@/server/db";
import { actorTypeOf, type Queryable, type ServiceContext } from "@/server/services";

/** Account-level audit actions, as `entity.event` like the tournament ones. */
export const AUTH_AUDIT_ACTIONS = {
  organisationCreated: "organisation.created",
  userCreated: "user.created",
  userPasswordChanged: "user.password_changed",
  userPasswordReset: "user.password_reset",
  userSessionsRevoked: "user.sessions_revoked",
  inviteCreated: "invite.created",
  inviteAccepted: "invite.accepted",
} as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[keyof typeof AUTH_AUDIT_ACTIONS];

export interface AuthAuditEntry {
  action: AuthAuditAction;
  /** "user", "organisation" or "invite". */
  entityType: string;
  entityId: string | null;
  reason?: string | null;
  after?: unknown;
}

/** Appends one account-level audit row inside the caller's transaction. */
export async function recordAuthAudit(
  tx: Queryable,
  ctx: ServiceContext,
  entry: AuthAuditEntry,
): Promise<void> {
  const reason = entry.reason?.trim() ?? "";
  await tx.insert(auditLog).values({
    tournamentId: null,
    at: ctx.now(),
    actorType: actorTypeOf(ctx.actor),
    actorId: ctx.actor.id,
    actorName: ctx.actor.name,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    reason: reason.length > 0 ? reason : null,
    after: entry.after ?? null,
    requestId: ctx.requestId,
  });
}
