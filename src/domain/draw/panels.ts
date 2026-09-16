import type { Judge } from "../types";

/**
 * Judge panels for the draw.
 *
 * Two panel modes:
 * - fixed-room: judges with a home room follow that room all day. Rooms short
 *   of judges are topped up from judges with no home room, and those judges
 *   then also stay with that room for every round.
 * - per-round: every round gets fresh panels. No judge sits twice in a round,
 *   and the rotation tries to show each judge a different room each round.
 */

/** The largest panel the sheet grid supports. */
export const MAX_PANEL_SIZE = 5;

/** One debate slot while the draw is being built. */
export interface DrawSlot {
  divisionCode: string;
  round: number;
  /** Position of this pairing within its division's round, from 0. */
  index: number;
  roomId: string;
  governmentTeamId: string;
  oppositionTeamId: string;
  judgeIds: string[];
}

export interface PanelResult {
  slots: DrawSlot[];
  warnings: string[];
}

interface FixedRoomInput {
  slots: readonly DrawSlot[];
  /** Active judges not already used by debates outside this draw. */
  judges: readonly Judge[];
  judgesPerRoom: number;
  roomName: (roomId: string) => string;
}

/** Builds one panel per room and copies it to every debate in that room. */
export function fixedRoomPanels(input: FixedRoomInput): PanelResult {
  const { judges, judgesPerRoom, roomName } = input;
  const warnings: string[] = [];
  const roomIds = uniqueInOrder(input.slots.map((slot) => slot.roomId));
  const reserves = judges.filter((judge) => !judge.homeRoomId);
  const panels = new Map<string, string[]>();

  for (const roomId of roomIds) {
    let panel = judges.filter((judge) => judge.homeRoomId === roomId).map((judge) => judge.id);
    if (panel.length > MAX_PANEL_SIZE) {
      warnings.push(
        `${roomName(roomId)} has ${panel.length} judges allocated; only the first ${MAX_PANEL_SIZE} are on its panel.`,
      );
      panel = panel.slice(0, MAX_PANEL_SIZE);
    }
    while (panel.length < judgesPerRoom && reserves.length) {
      panel.push((reserves.shift() as Judge).id);
    }
    if (panel.length === 0) {
      warnings.push(`${roomName(roomId)} has no judges yet.`);
    } else if (panel.length < judgesPerRoom) {
      warnings.push(
        `${roomName(roomId)} has ${countJudges(panel.length)}; the tournament wants ${judgesPerRoom} per room.`,
      );
    }
    panels.set(roomId, panel);
  }

  for (const judge of judges) {
    if (judge.homeRoomId && !panels.has(judge.homeRoomId)) {
      warnings.push(
        `${judge.name} is allocated to ${roomName(judge.homeRoomId)}, which is not used in this draw.`,
      );
    }
  }

  const slots = input.slots.map((slot) => ({
    ...slot,
    judgeIds: [...(panels.get(slot.roomId) ?? [])],
  }));
  return { slots, warnings };
}

interface PerRoundInput {
  slots: readonly DrawSlot[];
  /** Active judges free in the given round, in a stable order. */
  judgesForRound: (round: number) => readonly Judge[];
  judgesPerRoom: number;
  roomName: (roomId: string) => string;
}

/** Builds fresh panels for every round from the judges free in that round. */
export function perRoundPanels(input: PerRoundInput): PanelResult {
  const { judgesPerRoom, roomName } = input;
  const warnings: string[] = [];
  const visited = new Map<string, Set<string>>();
  const slots = input.slots.map((slot) => ({ ...slot, judgeIds: [] as string[] }));
  const rounds = uniqueInOrder(slots.map((slot) => slot.round));

  rounds.forEach((round, roundIndex) => {
    const roundSlots = slots.filter((slot) => slot.round === round);
    const judges = input.judgesForRound(round);
    const seatsPerRound = roundSlots.length * judgesPerRoom;
    const order = rotate(judges, judges.length ? (roundIndex * seatsPerRound) % judges.length : 0);
    const used = new Set<string>();

    for (let seat = 0; seat < judgesPerRoom; seat += 1) {
      for (const slot of roundSlots) {
        const fresh = order.find(
          (judge) => !used.has(judge.id) && !visited.get(judge.id)?.has(slot.roomId),
        );
        const judge = fresh ?? order.find((candidate) => !used.has(candidate.id));
        if (!judge) continue;
        used.add(judge.id);
        const rooms = visited.get(judge.id) ?? new Set<string>();
        rooms.add(slot.roomId);
        visited.set(judge.id, rooms);
        slot.judgeIds.push(judge.id);
      }
    }

    const short = roundSlots.filter((slot) => slot.judgeIds.length < judgesPerRoom);
    if (short.length) {
      warnings.push(
        `Round ${round} has ${countJudges(judges.length)} for ${roundSlots.length} rooms; ${judgesPerRoom} per room needs ${seatsPerRound}. ${short.length === 1 ? "One panel is" : `${short.length} panels are`} short.`,
      );
    }
    for (const slot of roundSlots) {
      if (slot.judgeIds.length === 0) {
        warnings.push(`${roomName(slot.roomId)} has no judges in round ${round}.`);
      }
    }
  });

  return { slots, warnings };
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  if (!items.length) return [];
  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function countJudges(count: number): string {
  return count === 1 ? "1 judge" : `${count} judges`;
}
