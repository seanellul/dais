/**
 * Rooms and fixed panels: list, create, rename, reorder, delete, generate a
 * numbered set, set the judges who stay in one room all day, and the
 * capacity sentence the Rooms page shows in words.
 *
 * A room's name is display-only on a sheet, so renaming refreshes kept
 * sheets in place through `refreshAssignments`. A room that hosts a debate
 * cannot be deleted; take it out of the draw first.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { MAX_PANEL_SIZE } from "@/domain/draw";
import { judges, rooms, type JudgeRow, type RoomRow, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import { isUniqueViolation, type Queryable, type ServiceContext } from "./context";
import { refreshAssignments } from "./draw";
import { loadGraph, settingsOf, toSchedule } from "./graph";
import { violatedConstraint } from "./tournaments";

export interface CreateRoomInput {
  name: string;
  /** Appended after the last room when omitted. */
  sortOrder?: number;
}

export interface UpdateRoomInput {
  name: string;
  expectedRevision?: number;
}

export interface DivisionCapacity {
  code: string;
  name: string;
  teams: number;
  roomsNeeded: number;
}

/** What the Rooms page needs to say, in numbers and as one sentence. */
export interface CapacitySummary {
  panelMode: "fixed-room" | "per-round";
  judgesPerRoom: number;
  /** Rooms needed at once: every division debates in the same round. */
  roomsNeeded: number;
  roomsAvailable: number;
  roomsShort: number;
  judgesAvailable: number;
  judgesNeeded: number;
  judgesShort: number;
  divisions: DivisionCapacity[];
  sentence: string;
}

// ---------------------------------------------------------------------------
// Reads

export async function listRooms(db: Queryable, tournamentId: string): Promise<RoomRow[]> {
  return db
    .select()
    .from(rooms)
    .where(eq(rooms.tournamentId, tournamentId))
    .orderBy(asc(rooms.sortOrder), asc(rooms.name), asc(rooms.id));
}

async function getRoom(db: Queryable, tournamentId: string, roomId: string): Promise<RoomRow> {
  const [row] = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.tournamentId, tournamentId), eq(rooms.id, roomId)))
    .limit(1);
  if (!row) throw errors.notFound("That room");
  return row;
}

function requireName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    throw errors.validation("Give the room a name.", {
      issues: [{ path: "name", message: "A name is required." }],
    });
  }
  return trimmed;
}

function roomClash(error: unknown, name: string): unknown {
  if (isUniqueViolation(error) && violatedConstraint(error) === "rooms_name_unique") {
    return errors.validation(`A room called ${name} already exists.`, {
      issues: [{ path: "name", message: "This room name is already in use." }],
    });
  }
  return error;
}

async function nextSortOrder(db: Queryable, tournamentId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${rooms.sortOrder}), 0)::int` })
    .from(rooms)
    .where(eq(rooms.tournamentId, tournamentId));
  return (row?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Writes

export async function createRoom(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: CreateRoomInput,
): Promise<RoomRow> {
  const name = requireName(input.name);
  const sortOrder = input.sortOrder ?? (await nextSortOrder(tx, tournamentId));
  let room: RoomRow;
  try {
    [room] = await tx.transaction((sp) =>
      sp.insert(rooms).values({ tournamentId, name, sortOrder, createdAt: ctx.now() }).returning(),
    );
  } catch (error) {
    throw roomClash(error, name);
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roomsCreated,
    entityType: "room",
    entityId: room.id,
    after: { name, sortOrder },
  });
  return room;
}

/** Renames a room. Sheets in that room show the new name; nothing retires. */
export async function updateRoom(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  roomId: string,
  input: UpdateRoomInput,
): Promise<RoomRow> {
  const current = await getRoom(tx, tournamentId, roomId);
  const name = requireName(input.name);
  if (name === current.name) return current;
  let room: RoomRow;
  try {
    [room] = await tx.transaction((sp) =>
      sp.update(rooms).set({ name }).where(eq(rooms.id, roomId)).returning(),
    );
  } catch (error) {
    throw roomClash(error, name);
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roomsUpdated,
    entityType: "room",
    entityId: roomId,
    diff: diffOf({ name: current.name }, { name }),
  });
  const graph = await loadGraph(tx, tournamentId);
  if (graph.debates.some((debate) => debate.roomId === roomId)) {
    await refreshAssignments(tx, ctx, tournamentId, { expectedRevision: input.expectedRevision });
  }
  return room;
}

/** Puts the rooms in the given order; rooms not listed keep their place after the listed ones. */
export async function reorderRooms(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  roomIds: string[],
): Promise<RoomRow[]> {
  const current = await listRooms(tx, tournamentId);
  const known = new Set(current.map((room) => room.id));
  const unknown = roomIds.find((id) => !known.has(id));
  if (unknown !== undefined) throw errors.notFound("That room");
  const ordered = [
    ...roomIds.filter((id, index) => roomIds.indexOf(id) === index),
    ...current.map((room) => room.id).filter((id) => !roomIds.includes(id)),
  ];
  for (const [index, id] of ordered.entries()) {
    await tx
      .update(rooms)
      .set({ sortOrder: index + 1 })
      .where(eq(rooms.id, id));
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roomsUpdated,
    entityType: "tournament",
    entityId: tournamentId,
    diff: diffOf(
      { order: current.map((room) => room.name) },
      { order: ordered.map((id) => current.find((room) => room.id === id)?.name ?? id) },
    ),
  });
  return listRooms(tx, tournamentId);
}

/** Removes a room that no debate uses. Judges allocated to it lose their home room. */
export async function deleteRoom(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  roomId: string,
): Promise<void> {
  const room = await getRoom(tx, tournamentId, roomId);
  const graph = await loadGraph(tx, tournamentId);
  const used = graph.debates.filter((debate) => debate.roomId === roomId);
  if (used.length > 0) {
    const roundsUsed = [...new Set(used.map((debate) => debate.round))].sort((a, b) => a - b);
    throw errors.validation(
      `${room.name} is in the draw for round ${roundsUsed.join(", ")}. Move those debates to another room first.`,
    );
  }
  const homeJudges = graph.judges.filter((judge) => judge.homeRoomId === roomId);
  if (homeJudges.length > 0) {
    await tx
      .update(judges)
      .set({ homeRoomId: null, updatedAt: ctx.now() })
      .where(and(eq(judges.tournamentId, tournamentId), eq(judges.homeRoomId, roomId)));
  }
  await tx.delete(rooms).where(eq(rooms.id, roomId));
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roomsDeleted,
    entityType: "room",
    entityId: roomId,
    before: { name: room.name, homeJudges: homeJudges.map((judge) => judge.name) },
  });
}

/**
 * Adds numbered rooms ("Room 1", "Room 2", ...) until the tournament has
 * `count` rooms, skipping names already taken. Returns the rooms added.
 */
export async function generateRooms(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  count: number,
): Promise<RoomRow[]> {
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw errors.validation("Choose between 1 and 200 rooms.", {
      issues: [{ path: "count", message: "Between 1 and 200." }],
    });
  }
  const existing = await listRooms(tx, tournamentId);
  const taken = new Set(existing.map((room) => room.name.trim().toLowerCase()));
  const names: string[] = [];
  for (let index = 1; existing.length + names.length < count; index += 1) {
    const name = `Room ${index}`;
    if (!taken.has(name.toLowerCase())) names.push(name);
  }
  if (names.length === 0) return [];
  const start = await nextSortOrder(tx, tournamentId);
  const now = ctx.now();
  const added = await tx
    .insert(rooms)
    .values(
      names.map((name, index) => ({
        tournamentId,
        name,
        sortOrder: start + index,
        createdAt: now,
      })),
    )
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.roomsCreated,
    entityType: "tournament",
    entityId: tournamentId,
    after: { added: names },
  });
  return added;
}

/**
 * Makes the given judges the room's fixed panel (one to five). Judges the
 * room had before and are not listed lose their home room. The change shows
 * in the next draw; existing debates keep their panels.
 */
export async function setFixedPanel(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  roomId: string,
  judgeIds: string[],
): Promise<JudgeRow[]> {
  const room = await getRoom(tx, tournamentId, roomId);
  const unique = [...new Set(judgeIds)];
  if (unique.length < 1 || unique.length > MAX_PANEL_SIZE) {
    throw errors.validation(`A panel has between one and ${MAX_PANEL_SIZE} judges.`, {
      issues: [{ path: "judgeIds", message: `Choose 1 to ${MAX_PANEL_SIZE} judges.` }],
    });
  }
  const chosen = await tx
    .select()
    .from(judges)
    .where(and(eq(judges.tournamentId, tournamentId), inArray(judges.id, unique)));
  if (chosen.length !== unique.length) throw errors.notFound("That judge");
  const withdrawn = chosen.find((judge) => judge.status !== "active");
  if (withdrawn) {
    throw errors.validation(`${withdrawn.name} has withdrawn and can't sit on a panel.`);
  }
  const before = await tx
    .select({ id: judges.id, name: judges.name })
    .from(judges)
    .where(and(eq(judges.tournamentId, tournamentId), eq(judges.homeRoomId, roomId)));
  const now = ctx.now();
  const leaving = before.map((judge) => judge.id).filter((id) => !unique.includes(id));
  if (leaving.length > 0) {
    await tx
      .update(judges)
      .set({ homeRoomId: null, updatedAt: now })
      .where(and(eq(judges.tournamentId, tournamentId), inArray(judges.id, leaving)));
  }
  await tx
    .update(judges)
    .set({ homeRoomId: roomId, updatedAt: now })
    .where(and(eq(judges.tournamentId, tournamentId), inArray(judges.id, unique)));
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.judgesUpdated,
    entityType: "room",
    entityId: roomId,
    diff: diffOf(
      { panel: before.map((judge) => judge.name) },
      { panel: unique.map((id) => chosen.find((judge) => judge.id === id)?.name ?? id) },
    ),
    after: { room: room.name },
  });
  return tx
    .select()
    .from(judges)
    .where(and(eq(judges.tournamentId, tournamentId), eq(judges.homeRoomId, roomId)))
    .orderBy(asc(judges.code));
}

// ---------------------------------------------------------------------------
// Capacity

/** Rooms and judges needed against rooms and judges listed, with the sentence the page shows. */
export async function capacitySummary(
  db: Queryable,
  tournamentId: string,
): Promise<CapacitySummary> {
  const graph = await loadGraph(db, tournamentId);
  const settings = settingsOf(graph.tournament);
  const schedule = toSchedule(graph);
  const perDivision: DivisionCapacity[] = settings.divisions.map((division) => {
    const teamCount = schedule.teams.filter(
      (team) => team.divisionCode === division.code && team.status === "active",
    ).length;
    return {
      code: division.code,
      name: division.name,
      teams: teamCount,
      roomsNeeded: Math.ceil(teamCount / 2),
    };
  });
  const roomsNeeded = perDivision.reduce((sum, division) => sum + division.roomsNeeded, 0);
  const roomsAvailable = schedule.rooms.length;
  const judgesAvailable = schedule.judges.filter((judge) => judge.status === "active").length;
  const judgesPerRoom = settings.judgesPerRoom;
  const judgesNeeded = roomsNeeded * judgesPerRoom;
  const summary: Omit<CapacitySummary, "sentence"> = {
    panelMode: settings.panelMode,
    judgesPerRoom,
    roomsNeeded,
    roomsAvailable,
    roomsShort: Math.max(0, roomsNeeded - roomsAvailable),
    judgesAvailable,
    judgesNeeded,
    judgesShort: Math.max(0, judgesNeeded - judgesAvailable),
    divisions: perDivision,
  };
  return { ...summary, sentence: capacitySentence(summary) };
}

function capacitySentence(summary: Omit<CapacitySummary, "sentence">): string {
  if (summary.roomsNeeded === 0) {
    return "Add teams first; the number of rooms follows from the number of teams.";
  }
  const breakdown = summary.divisions
    .filter((division) => division.roomsNeeded > 0)
    .map((division) => `${division.roomsNeeded} for ${division.name}`)
    .join(" and ");
  const roomsListed = count(summary.roomsAvailable, "room");
  const rooms =
    summary.roomsShort > 0
      ? `Each round needs ${count(summary.roomsNeeded, "room")} at once (${breakdown}); only ${roomsListed} ${plural(summary.roomsAvailable, "is", "are")} listed, ${summary.roomsShort} short.`
      : `Each round needs ${count(summary.roomsNeeded, "room")} at once (${breakdown}); ${roomsListed} ${plural(summary.roomsAvailable, "is", "are")} listed.`;
  const judgesListed = count(summary.judgesAvailable, "judge");
  const perRoom = count(summary.judgesPerRoom, "judge");
  const judges =
    summary.judgesShort > 0
      ? `With ${perRoom} per room that takes ${count(summary.judgesNeeded, "judge")}; ${judgesListed} ${plural(summary.judgesAvailable, "is", "are")} listed, ${summary.judgesShort} short.`
      : `With ${perRoom} per room that takes ${count(summary.judgesNeeded, "judge")}; ${judgesListed} ${plural(summary.judgesAvailable, "is", "are")} listed.`;
  return `${rooms} ${judges}`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function plural(value: number, one: string, many: string): string {
  return value === 1 ? one : many;
}

/** Judges with no home room, for the Rooms page's "not allocated yet" list. */
export async function unallocatedJudges(db: Queryable, tournamentId: string): Promise<JudgeRow[]> {
  return db
    .select()
    .from(judges)
    .where(
      and(
        eq(judges.tournamentId, tournamentId),
        eq(judges.status, "active"),
        isNull(judges.homeRoomId),
      ),
    )
    .orderBy(asc(judges.name));
}
