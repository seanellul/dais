/**
 * The audit trail. Every change an organiser, judge or the system makes is
 * one row in `audit_log`, written in the same transaction as the change so
 * neither can exist without the other. Rows are append-only (a trigger
 * refuses updates and deletes).
 *
 * The history page turns rows into plain sentences from `action`, the actor
 * and `diff`, so actions are stable strings from `AUDIT_ACTIONS`, never free
 * text, and diffs are small (microdiff output over the changed record, not
 * whole snapshots).
 */
import diff, { type Difference } from "microdiff";

import { auditLog, type AuditLogRow } from "@/server/db";
import { errors } from "@/server/errors";

import type { Actor, Queryable, ServiceContext } from "./context";

/**
 * Every audit action, as `entity.event`. The value is what the database
 * stores; the key is what code uses (`AUDIT_ACTIONS.sheetCorrected`).
 */
export const AUDIT_ACTIONS = {
  teamsImported: "teams.imported",
  teamsCreated: "teams.created",
  teamsUpdated: "teams.updated",
  teamsDeleted: "teams.deleted",
  judgesCreated: "judges.created",
  judgesUpdated: "judges.updated",
  judgesReplaced: "judges.replaced",
  judgesSessionsRevoked: "judges.sessions_revoked",
  judgesCodeRegenerated: "judges.code_regenerated",
  judgesCardIssued: "judges.card_issued",
  roomsCreated: "rooms.created",
  roomsUpdated: "rooms.updated",
  roomsDeleted: "rooms.deleted",
  drawGenerated: "draw.generated",
  drawSaved: "draw.saved",
  drawEdited: "draw.edited",
  /** A draw edit retired a sheet that had scores; the organiser gave a reason. */
  drawSheetOrphaned: "draw.sheet_orphaned",
  roundsOpened: "rounds.opened",
  roundsClosed: "rounds.closed",
  sheetReceived: "sheet.received",
  sheetPaperEntered: "sheet.paper_entered",
  sheetCorrected: "sheet.corrected",
  sheetDuplicateAbsorbed: "sheet.duplicate_absorbed",
  conflictResolved: "conflict.resolved",
  sheetWaived: "sheet.waived",
  sheetWaiverRevoked: "sheet.waiver_revoked",
  overrideAdded: "override.added",
  overrideRevoked: "override.revoked",
  divisionFinalized: "division.finalized",
  divisionReopened: "division.reopened",
  checklistOverridden: "checklist.overridden",
  settingsUpdated: "settings.updated",
  backupExported: "backup.exported",
  backupImported: "backup.imported",
  backupRestored: "backup.restored",
  demoCreated: "demo.created",
  demoSimulated: "demo.simulated",
  demoReset: "demo.reset",
  judgeHandoffEntered: "judge.handoff_entered",
} as const;

/** One of the strings in `AUDIT_ACTIONS`. */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Actions that are organiser overrides: each needs a non-empty reason, and
 * `recordAudit` refuses to write one without. The database CHECK
 * `audit_log_reason_required` covers the older underscore names from the
 * first migration; this set is the rule for the dotted names.
 */
export const AUDIT_ACTIONS_REQUIRING_REASON: ReadonlySet<string> = new Set<string>([
  "sheet.orphan_attached",
  "sheet.orphan_discarded",
  AUDIT_ACTIONS.drawSheetOrphaned,
  AUDIT_ACTIONS.sheetPaperEntered,
  AUDIT_ACTIONS.sheetCorrected,
  AUDIT_ACTIONS.conflictResolved,
  AUDIT_ACTIONS.sheetWaived,
  AUDIT_ACTIONS.sheetWaiverRevoked,
  AUDIT_ACTIONS.judgeHandoffEntered,
  AUDIT_ACTIONS.overrideAdded,
  AUDIT_ACTIONS.overrideRevoked,
  AUDIT_ACTIONS.divisionReopened,
  AUDIT_ACTIONS.checklistOverridden,
  AUDIT_ACTIONS.backupRestored,
]);

/** What a service passes to `recordAudit`. The actor, time and request id come from the context. */
export interface AuditEntry {
  tournamentId: string;
  /** One of `AUDIT_ACTIONS`. Typed as string so callers can pass the constant or a literal. */
  action: string;
  /** The kind of record touched: "team", "judge", "sheet", "division", "tournament"... */
  entityType: string;
  /** The record's id, or null for a tournament-wide action such as an import. */
  entityId: string | null;
  /** Mandatory for every action in `AUDIT_ACTIONS_REQUIRING_REASON`. Trimmed before storing. */
  reason?: string | null;
  /** `diffOf(before, after)`; kept small enough to show on the history page. */
  diff?: unknown;
  /** The record before the change, when a diff alone would not explain it. */
  before?: unknown;
  /** The record after the change. */
  after?: unknown;
  divisionCode?: string | null;
  assignmentId?: string | null;
}

/** The `actor_type` enum value for an actor: organisers are `user` in code and `organiser` in the log. */
export function actorTypeOf(actor: Actor): AuditLogRow["actorType"] {
  return actor.type === "user" ? "organiser" : actor.type;
}

/**
 * Appends one audit row inside the caller's transaction. Throws
 * `errors.validation` when the action is an override and the reason is blank,
 * so the organiser sees "Give a reason" rather than a database error.
 */
export async function recordAudit(
  tx: Queryable,
  ctx: ServiceContext,
  entry: AuditEntry,
): Promise<void> {
  const reason = entry.reason?.trim() ?? "";
  if (reason.length === 0 && AUDIT_ACTIONS_REQUIRING_REASON.has(entry.action)) {
    throw errors.validation("Give a reason for this change. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  await tx.insert(auditLog).values({
    tournamentId: entry.tournamentId,
    at: ctx.now(),
    actorType: actorTypeOf(ctx.actor),
    actorId: ctx.actor.id,
    actorName: ctx.actor.name,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    divisionCode: entry.divisionCode ?? null,
    assignmentId: entry.assignmentId ?? null,
    reason: reason.length > 0 ? reason : null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    diff: entry.diff ?? null,
    requestId: ctx.requestId,
  });
}

/**
 * The compact list of changes between two records: one entry per changed
 * path with the old and new value (microdiff's format, which the history
 * page renders). `null` and `undefined` count as empty records; a scalar is
 * compared under the key "value".
 */
export function diffOf(before: unknown, after: unknown): Difference[] {
  return diff(asRecord(before), asRecord(after));
}

function asRecord(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return value as Record<string, unknown>;
  if (value === null || value === undefined) return {};
  return { value };
}
