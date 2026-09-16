/**
 * Judges: list with device and sign-in summaries, create with a card code
 * and a join token, edit, regenerate the code, replace a judge mid-day, and
 * set the home room for fixed-room panels.
 *
 * Join tokens and sign-out belong to `src/server/auth`: a join token is
 * derived from the judge's id and session epoch (`joinTokenFor`), only its
 * hash is stored, and `revokeJudgeSessions` bumps the epoch, which signs
 * every device out and rotates the token in one move. This module stores
 * the hash when a judge is created and calls those two functions otherwise.
 *
 * Replacing a judge (failure mode 7 in the plan). Only debates without a
 * received sheet from the old judge move to the new one: the new judge takes
 * the old one's seat, the old sheets retire with successors, the old judge
 * is withdrawn and signed out everywhere. Debates already scored keep the
 * old judge and their sheets.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { revokeJudgeSessions } from "@/server/auth/judge-session";
import { issueJoinToken, joinTokenFor, joinTokenHashFor } from "@/server/auth/tokens";
import {
  assignments,
  judgeDevices,
  judges,
  rooms,
  sessions,
  type JudgeDeviceRow,
  type JudgeRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import { isUniqueViolation, type Queryable, type ServiceContext } from "./context";
import {
  RETIRED_REASONS,
  applyScheduleChange,
  refreshAssignments,
  type DebateInput,
  type SaveDrawResult,
} from "./draw";
import { loadGraph, settingsOf, toSchedule, type TournamentGraph } from "./graph";
import { crockfordCode, newId } from "./ids";
import { lockTournament, retryOnUniqueViolation, violatedConstraint } from "./tournaments";

/** Symbols in a generated judge code. Four Crockford symbols read well on a card. */
const JUDGE_CODE_LENGTH = 4;
const JUDGE_CODE_ATTEMPTS = 5;

export interface JudgeSummary extends JudgeRow {
  devices: JudgeDeviceRow[];
  /** Live sessions on the current epoch. */
  activeSessions: number;
  /** The latest heartbeat from any device, or the latest session activity. */
  lastSeenAt: Date | null;
}

export interface CreateJudgeInput {
  name: string;
  /** Generated when omitted. Case-insensitive per tournament. */
  code?: string;
  homeRoomId?: string | null;
}

export interface UpdateJudgeInput {
  name?: string;
  homeRoomId?: string | null;
  status?: JudgeRow["status"];
  expectedRevision?: number;
}

export interface ReplaceJudgeInput {
  oldJudgeId: string;
  /** An existing active judge, or omit and give `newName` to create one. */
  newJudgeId?: string;
  newName?: string;
  reason?: string;
  expectedRevision?: number;
}

export interface ReplaceJudgeResult {
  newJudge: JudgeRow;
  /** Present when the judge was created here; print it on the card. */
  joinToken: string | null;
  /** Debates that kept the old judge because a sheet had been received. */
  keptDebateIds: string[];
  /** Sheets moved to the new judge; the old judge's phone may hold an unsent draft for each. */
  movedSheets: {
    assignmentId: string;
    successorId: string | null;
    round: number;
    roomName: string;
  }[];
  draw: SaveDrawResult | null;
}

// ---------------------------------------------------------------------------
// Reads

/** Every judge with their devices and live sessions. `now` decides which sessions still count. */
export async function listJudges(
  db: Queryable,
  tournamentId: string,
  now: Date = new Date(),
): Promise<JudgeSummary[]> {
  const [judgeRows, deviceRows, sessionRows] = await Promise.all([
    db
      .select()
      .from(judges)
      .where(eq(judges.tournamentId, tournamentId))
      .orderBy(asc(judges.code), asc(judges.id)),
    db
      .select()
      .from(judgeDevices)
      .where(eq(judgeDevices.tournamentId, tournamentId))
      .orderBy(asc(judgeDevices.judgeId), asc(judgeDevices.lastSeenAt)),
    db
      .select({
        judgeId: sessions.judgeId,
        epoch: sessions.epoch,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tournamentId, tournamentId),
          eq(sessions.kind, "judge"),
          isNull(sessions.revokedAt),
        ),
      ),
  ]);
  return judgeRows.map((judge) => {
    const devices = deviceRows.filter((device) => device.judgeId === judge.id);
    const live = sessionRows.filter(
      (session) =>
        session.judgeId === judge.id &&
        session.epoch === judge.sessionEpoch &&
        session.expiresAt.getTime() > now.getTime(),
    );
    const seen = [
      ...devices.map((device) => device.lastSeenAt),
      ...live.map((session) => session.lastSeenAt),
    ].filter((value): value is Date => value instanceof Date);
    const lastSeenAt = seen.length ? new Date(Math.max(...seen.map((d) => d.getTime()))) : null;
    return { ...judge, devices, activeSessions: live.length, lastSeenAt };
  });
}

async function getJudge(db: Queryable, tournamentId: string, judgeId: string): Promise<JudgeRow> {
  const [row] = await db
    .select()
    .from(judges)
    .where(and(eq(judges.tournamentId, tournamentId), eq(judges.id, judgeId)))
    .limit(1);
  if (!row) throw errors.notFound("That judge");
  return row;
}

// ---------------------------------------------------------------------------
// Validation helpers

function requireName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    throw errors.validation("Give the judge a name.", {
      issues: [{ path: "name", message: "A name is required." }],
    });
  }
  return trimmed;
}

async function requireRoom(db: Queryable, tournamentId: string, roomId: string | null | undefined) {
  if (!roomId) return null;
  const rows = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.tournamentId, tournamentId), eq(rooms.id, roomId)))
    .limit(1);
  if (rows.length === 0) throw errors.notFound("That room");
  return roomId;
}

function codeTaken(code: string) {
  return errors.validation(`Judge code ${code} is already used. Choose another.`, {
    issues: [{ path: "code", message: "This judge code is already in use." }],
  });
}

// ---------------------------------------------------------------------------
// Create, update, regenerate

/** Creates a judge with a card code and a join token for the card. */
export async function createJudge(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: CreateJudgeInput,
): Promise<{ judge: JudgeRow; joinToken: string }> {
  const name = requireName(input.name);
  const homeRoomId = await requireRoom(tx, tournamentId, input.homeRoomId);
  const chosenCode = input.code?.trim().toUpperCase();
  const now = ctx.now();
  // The id is chosen here because the join token is derived from it.
  const id = newId();
  const fresh = { id, sessionEpoch: 0 };

  const insert = async (sp: Tx, code: string) => {
    const [row] = await sp
      .insert(judges)
      .values({
        id,
        tournamentId,
        name,
        code,
        joinTokenHash: joinTokenHashFor(fresh),
        homeRoomId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  };
  let judge: JudgeRow;
  try {
    judge = chosenCode
      ? await tx.transaction((sp) => insert(sp, chosenCode))
      : await retryOnUniqueViolation(tx, "judges_code_unique", JUDGE_CODE_ATTEMPTS, (sp) =>
          insert(sp, crockfordCode(JUDGE_CODE_LENGTH)),
        );
  } catch (error) {
    if (isUniqueViolation(error) && violatedConstraint(error) === "judges_code_unique") {
      throw codeTaken(chosenCode ?? "");
    }
    throw error;
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.judgesCreated,
    entityType: "judge",
    entityId: judge.id,
    after: { name, code: judge.code, homeRoomId },
  });
  return { judge, joinToken: joinTokenFor(fresh) };
}

/** Edits a judge. A renamed judge's kept sheets are refreshed in place. */
export async function updateJudge(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  judgeId: string,
  patch: UpdateJudgeInput,
): Promise<JudgeRow> {
  const current = await getJudge(tx, tournamentId, judgeId);
  const name = patch.name === undefined ? current.name : requireName(patch.name);
  const homeRoomId =
    patch.homeRoomId === undefined
      ? current.homeRoomId
      : await requireRoom(tx, tournamentId, patch.homeRoomId);
  const status = patch.status ?? current.status;
  const before = { name: current.name, homeRoomId: current.homeRoomId, status: current.status };
  const after = { name, homeRoomId, status };
  const diff = diffOf(before, after);
  if (diff.length === 0) return current;

  const [row] = await tx
    .update(judges)
    .set({ name, homeRoomId, status, updatedAt: ctx.now() })
    .where(and(eq(judges.tournamentId, tournamentId), eq(judges.id, judgeId)))
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.judgesUpdated,
    entityType: "judge",
    entityId: judgeId,
    diff,
  });
  if (name !== current.name && (await judgeIsSeated(tx, tournamentId, judgeId))) {
    await refreshAssignments(tx, ctx, tournamentId, { expectedRevision: patch.expectedRevision });
  }
  return row;
}

async function judgeIsSeated(
  db: Queryable,
  tournamentId: string,
  judgeId: string,
): Promise<boolean> {
  const graph = await loadGraph(db, tournamentId);
  return graph.debateJudges.some((row) => row.judgeId === judgeId);
}

/** Sets or clears the judge's fixed room. Panels are rebuilt when the draw is next generated. */
export async function setHomeRoom(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  judgeId: string,
  roomId: string | null,
): Promise<JudgeRow> {
  return updateJudge(tx, ctx, tournamentId, judgeId, { homeRoomId: roomId });
}

/**
 * Issues a new card code and signs the judge out everywhere, for a lost or
 * leaked card. Signing out moves the epoch on, which gives a new join token;
 * its hash is stored and the token returned for the new card.
 */
export async function regenerateCode(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  judgeId: string,
): Promise<{ judge: JudgeRow; joinToken: string }> {
  const current = await getJudge(tx, tournamentId, judgeId);
  const now = ctx.now();
  const recoded = await retryOnUniqueViolation(
    tx,
    "judges_code_unique",
    JUDGE_CODE_ATTEMPTS,
    async (sp) => {
      const [row] = await sp
        .update(judges)
        .set({ code: crockfordCode(JUDGE_CODE_LENGTH), updatedAt: now })
        .where(and(eq(judges.tournamentId, tournamentId), eq(judges.id, judgeId)))
        .returning();
      return row;
    },
  );
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.judgesCodeRegenerated,
    entityType: "judge",
    entityId: judgeId,
    diff: diffOf({ code: current.code }, { code: recoded.code }),
  });
  await revokeJudgeSessions(tx, ctx, judgeId, "The judge's code was regenerated.");
  const joinToken = await issueJoinToken(tx, ctx, judgeId);
  return { judge: await getJudge(tx, tournamentId, judgeId), joinToken };
}

// ---------------------------------------------------------------------------
// Replace a judge

/** Replaces a judge on every debate that has no received sheet from them (module comment). */
export async function replaceJudge(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: ReplaceJudgeInput,
): Promise<ReplaceJudgeResult> {
  const tournament = await lockTournament(tx, tournamentId);
  if (input.expectedRevision !== undefined && tournament.revision !== input.expectedRevision) {
    throw errors.setupStale({
      currentRevision: tournament.revision,
      baseRevision: input.expectedRevision,
    });
  }
  const old = await getJudge(tx, tournamentId, input.oldJudgeId);
  const { judge: replacement, joinToken } = await resolveReplacement(
    tx,
    ctx,
    tournamentId,
    old,
    input,
  );
  const graph = await loadGraph(tx, tournamentId);

  // Debates already scored by the old judge keep them; the rest move.
  const sheetIds = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  const scoredDebateIds = new Set(
    graph.assignments
      .filter((row) => row.live && row.judgeId === old.id && sheetIds.has(row.id))
      .map((row) => row.debateId),
  );
  const schedule = toSchedule(graph);
  const moving = schedule.debates.filter(
    (debate) => debate.judgeIds.includes(old.id) && !scoredDebateIds.has(debate.id),
  );
  const next: DebateInput[] = schedule.debates.map((debate) =>
    moving.includes(debate)
      ? { ...debate, judgeIds: debate.judgeIds.map((id) => (id === old.id ? replacement.id : id)) }
      : debate,
  );

  const draw =
    moving.length > 0
      ? await applyScheduleChange(tx, ctx, tournamentId, { debates: next, audit: null })
      : null;
  const movedSheets = draw ? await linkSuccessors(tx, tournamentId, graph, old, replacement) : [];
  await withdrawOldJudge(tx, ctx, tournamentId, old, replacement, graph);

  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.judgesReplaced,
    entityType: "judge",
    entityId: old.id,
    reason: input.reason ?? null,
    after: {
      newJudgeId: replacement.id,
      newJudgeName: replacement.name,
      keptDebateIds: [...scoredDebateIds],
      movedSheets,
      revision: draw?.revision ?? tournament.revision,
    },
  });
  return {
    newJudge: replacement,
    joinToken,
    keptDebateIds: [...scoredDebateIds],
    movedSheets,
    draw,
  };
}

/**
 * Points each of the old judge's retired sheets at the new judge's sheet for
 * the same debate. To the domain a judge swap is one slot removed and one
 * added; to the judge's phone it is "the draw changed, open the new sheet",
 * which needs the successor link.
 */
async function linkSuccessors(
  tx: Tx,
  tournamentId: string,
  before: TournamentGraph,
  old: JudgeRow,
  replacement: JudgeRow,
): Promise<ReplaceJudgeResult["movedSheets"]> {
  const wasLive = new Set(
    before.assignments.filter((row) => row.live && row.judgeId === old.id).map((row) => row.id),
  );
  const rows = await tx
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.tournamentId, tournamentId),
        inArray(assignments.judgeId, [old.id, replacement.id]),
      ),
    );
  const retired = rows.filter((row) => wasLive.has(row.id) && row.retiredAt !== null);
  const moved: ReplaceJudgeResult["movedSheets"] = [];
  for (const row of retired) {
    const successor = rows.find(
      (candidate) =>
        candidate.judgeId === replacement.id &&
        candidate.debateId === row.debateId &&
        candidate.retiredAt === null,
    );
    await tx
      .update(assignments)
      .set({
        successorId: successor?.id ?? null,
        retiredReason: RETIRED_REASONS["matchup-changed"],
      })
      .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, row.id)));
    moved.push({
      assignmentId: row.id,
      successorId: successor?.id ?? null,
      round: row.identity.round,
      roomName: row.display.roomName,
    });
  }
  return moved;
}

/** The judge taking over: an existing active judge, or one created from `newName`. */
async function resolveReplacement(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  old: JudgeRow,
  input: ReplaceJudgeInput,
): Promise<{ judge: JudgeRow; joinToken: string | null }> {
  if (input.newJudgeId !== undefined) {
    if (input.newJudgeId === old.id)
      throw errors.validation("Choose a different judge to take over.");
    const judge = await getJudge(tx, tournamentId, input.newJudgeId);
    if (judge.status !== "active") {
      throw errors.validation(
        `${judge.name} has withdrawn and can't take over. Choose another judge.`,
      );
    }
    return { judge, joinToken: null };
  }
  if (input.newName?.trim()) {
    const created = await createJudge(tx, ctx, tournamentId, {
      name: input.newName,
      homeRoomId: old.homeRoomId,
    });
    return { judge: created.judge, joinToken: created.joinToken };
  }
  throw errors.validation("Name the new judge, or choose an existing one to take over.", {
    issues: [{ path: "newName", message: "A name or an existing judge is required." }],
  });
}

/**
 * Withdraws the old judge and signs them out. In fixed-room mode the room
 * passes to the replacement when they have none of their own.
 */
async function withdrawOldJudge(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  old: JudgeRow,
  replacement: JudgeRow,
  graph: TournamentGraph,
): Promise<void> {
  const now = ctx.now();
  const fixedRoom = settingsOf(graph.tournament).panelMode === "fixed-room";
  if (fixedRoom && old.homeRoomId && !replacement.homeRoomId) {
    await tx
      .update(judges)
      .set({ homeRoomId: old.homeRoomId, updatedAt: now })
      .where(eq(judges.id, replacement.id));
    replacement.homeRoomId = old.homeRoomId;
  }
  await tx
    .update(judges)
    .set({ status: "withdrawn", updatedAt: now })
    .where(and(eq(judges.tournamentId, tournamentId), eq(judges.id, old.id)));
  await revokeJudgeSessions(tx, ctx, old.id, `Replaced by ${replacement.name}.`);
}
