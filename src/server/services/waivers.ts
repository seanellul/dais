/**
 * Waivers: the organiser's decision that a sheet will not arrive and the
 * results should go ahead without it.
 *
 * A waiver is a row with a reason, never a deletion of the expectation: the
 * results page still lists the sheet as missing, marked waived, and the
 * scoring engine stops treating it as a blocker. Revoking a waiver is a
 * timestamp on the same row, with its own reason.
 */
import { and, eq, isNull } from "drizzle-orm";

import { sheetWaivers, type SheetWaiverRow } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { withTransaction, type Queryable, type ServiceContext } from "./context";
import { loadSheetSlot, readCurrentSheet, refuseWhenPublished } from "./sheets";

export interface WaiveSheetInput {
  tournamentId: string;
  assignmentId: string;
  reason: string;
}

/**
 * Marks a sheet as "won't arrive". Refused when the sheet has in fact been
 * received, when it is already waived, when the slot is retired (nothing
 * waits for an old-draw sheet) or when the division is published.
 */
export async function waiveSheet(
  ctx: ServiceContext,
  input: WaiveSheetInput,
): Promise<SheetWaiverRow> {
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, {
      lock: true,
      for: "organiser",
    });
    refuseWhenPublished(slot.division, "organiser");
    const current = await readCurrentSheet(tx, input.tournamentId, input.assignmentId);
    if (current.row !== null) {
      throw errors.validation(
        `The sheet from ${slot.judge.name} has been received; there is nothing to waive.`,
      );
    }
    if ((await liveWaiver(tx, input.tournamentId, input.assignmentId)) !== undefined) {
      throw errors.validation(
        `The sheet from ${slot.judge.name} is already marked as won't arrive.`,
      );
    }
    const [waiver] = await tx
      .insert(sheetWaivers)
      .values({
        tournamentId: input.tournamentId,
        assignmentId: input.assignmentId,
        reason: input.reason.trim(),
        createdBy: ctx.actor.name,
        createdAt: ctx.now(),
      })
      .returning();
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.sheetWaived,
      entityType: "sheet_waiver",
      entityId: waiver.id,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      after: { judgeName: slot.judge.name, round: slot.assignment.identity.round },
    });
    return waiver;
  });
}

export interface UnwaiveSheetInput {
  tournamentId: string;
  assignmentId: string;
  reason: string;
}

/** Takes a waiver back, so the results wait for the sheet again. */
export async function unwaiveSheet(
  ctx: ServiceContext,
  input: UnwaiveSheetInput,
): Promise<SheetWaiverRow> {
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const slot = await loadSheetSlot(tx, input.tournamentId, input.assignmentId, {
      lock: true,
      for: "organiser",
      allowRetired: true,
    });
    refuseWhenPublished(slot.division, "organiser");
    const waiver = await liveWaiver(tx, input.tournamentId, input.assignmentId);
    if (waiver === undefined) throw errors.notFound("A waiver for that sheet");
    const [revoked] = await tx
      .update(sheetWaivers)
      .set({ revokedAt: ctx.now(), revokedBy: ctx.actor.name, revokedReason: input.reason.trim() })
      .where(eq(sheetWaivers.id, waiver.id))
      .returning();
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.sheetWaiverRevoked,
      entityType: "sheet_waiver",
      entityId: waiver.id,
      assignmentId: input.assignmentId,
      divisionCode: slot.division.code,
      reason: input.reason,
      before: { reason: waiver.reason, createdBy: waiver.createdBy },
      after: { revoked: true },
    });
    return revoked;
  });
}

/** The live waiver for a sheet, if there is one. */
export async function liveWaiver(
  db: Queryable,
  tournamentId: string,
  assignmentId: string,
): Promise<SheetWaiverRow | undefined> {
  const [row] = await db
    .select()
    .from(sheetWaivers)
    .where(
      and(
        eq(sheetWaivers.tournamentId, tournamentId),
        eq(sheetWaivers.assignmentId, assignmentId),
        isNull(sheetWaivers.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

function requireReason(reason: string): void {
  if (typeof reason === "string" && reason.trim().length > 0) return;
  throw errors.validation("Give a reason for this change. It is kept in the history.", {
    issues: [{ path: "reason", message: "A reason is required." }],
  });
}
