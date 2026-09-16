/**
 * Rounds: open, close, reopen, and set the motion.
 *
 * Opening and closing are status flags with audit rows. Closing is soft: a
 * sheet that arrives after the close is still received (the live board tags
 * it late). The motion lives on the debates (one per round and division),
 * and the sheets of those debates show it, so setting it refreshes them in
 * place through `refreshAssignments`; nothing retires.
 */
import { and, asc, eq } from "drizzle-orm";

import { rounds, tournaments, type RoundRow, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import type { Queryable, ServiceContext } from "./context";
import { applyScheduleChange, type DebateInput, type SaveDrawResult } from "./draw";
import { loadGraph, toSchedule } from "./graph";
import { lockTournament } from "./tournaments";

export interface SetMotionInput {
  round: number;
  divisionCode: string;
  motion: string;
  expectedRevision?: number;
}

export interface SetMotionResult {
  /** Debates whose motion changed. */
  debates: number;
  draw: SaveDrawResult | null;
}

export async function listRounds(db: Queryable, tournamentId: string): Promise<RoundRow[]> {
  return db
    .select()
    .from(rounds)
    .where(eq(rounds.tournamentId, tournamentId))
    .orderBy(asc(rounds.number));
}

async function getRound(db: Queryable, tournamentId: string, number: number): Promise<RoundRow> {
  const [row] = await db
    .select()
    .from(rounds)
    .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, number)))
    .limit(1);
  if (!row) throw errors.notFound(`Round ${number}`);
  return row;
}

async function setStatus(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  round: RoundRow,
  status: RoundRow["status"],
  action: string,
  extra: Record<string, unknown> = {},
): Promise<RoundRow> {
  const [row] = await tx
    .update(rounds)
    .set({ status, closedAt: status === "closed" ? ctx.now() : null })
    .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, round.number)))
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action,
    entityType: "round",
    entityId: String(round.number),
    diff: diffOf({ status: round.status }, { status }),
    after: { round: round.number, ...extra },
  });
  return row;
}

/** Opens a round that has not run yet. Already open: unchanged. Closed: use `reopenRound`. */
export async function openRound(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  number: number,
): Promise<RoundRow> {
  const tournament = await lockTournament(tx, tournamentId);
  const round = await getRound(tx, tournamentId, number);
  if (round.status === "open") return round;
  if (round.status === "closed") {
    throw errors.validation(`Round ${number} is closed. Reopen it instead.`);
  }
  if (tournament.status === "setup") {
    await tx
      .update(tournaments)
      .set({ status: "running", updatedAt: ctx.now() })
      .where(eq(tournaments.id, tournamentId));
  }
  return setStatus(tx, ctx, tournamentId, round, "open", AUDIT_ACTIONS.roundsOpened);
}

/** Closes an open round. Late sheets are still received. */
export async function closeRound(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  number: number,
): Promise<RoundRow> {
  await lockTournament(tx, tournamentId);
  const round = await getRound(tx, tournamentId, number);
  if (round.status === "closed") return round;
  if (round.status === "pending") {
    throw errors.validation(`Round ${number} hasn't opened yet, so there is nothing to close.`);
  }
  return setStatus(tx, ctx, tournamentId, round, "closed", AUDIT_ACTIONS.roundsClosed);
}

/** Reopens a closed round, with an optional note for the history. */
export async function reopenRound(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  number: number,
  reason?: string,
): Promise<RoundRow> {
  await lockTournament(tx, tournamentId);
  const round = await getRound(tx, tournamentId, number);
  if (round.status === "open") return round;
  if (round.status === "pending") {
    throw errors.validation(`Round ${number} hasn't opened yet. Open it instead.`);
  }
  const [row] = await tx
    .update(rounds)
    .set({ status: "open", closedAt: null })
    .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, number)))
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roundsOpened,
    entityType: "round",
    entityId: String(number),
    reason: reason ?? null,
    diff: diffOf({ status: "closed" }, { status: "open" }),
    after: { round: number, reopened: true },
  });
  return row;
}

/**
 * Sets the motion on every debate of a round in one division. Sheets show
 * the motion, so they are refreshed; their ids do not change.
 */
export async function setMotion(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: SetMotionInput,
): Promise<SetMotionResult> {
  await getRound(tx, tournamentId, input.round);
  const motion = input.motion.trim();
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const known = schedule.settings.divisions.some(
    (division) => division.code === input.divisionCode,
  );
  if (!known) throw errors.notFound("That division");

  let changed = 0;
  const next: DebateInput[] = schedule.debates.map((debate) => {
    const target = debate.round === input.round && debate.divisionCode === input.divisionCode;
    if (!target || debate.motion === motion) return debate;
    changed += 1;
    return { ...debate, motion };
  });
  if (changed === 0) return { debates: 0, draw: null };

  const draw = await applyScheduleChange(tx, ctx, tournamentId, {
    debates: next,
    expectedRevision: input.expectedRevision,
    audit: {
      action: AUDIT_ACTIONS.drawEdited,
      entityType: "round",
      entityId: `${input.round}:${input.divisionCode}`,
    },
  });
  return { debates: changed, draw };
}
