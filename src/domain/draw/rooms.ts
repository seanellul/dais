import type { Judge, PanelMode, Room } from "../types";
import { compareText } from "./compare";
import type { SidedPair } from "./sides";

/**
 * Rooms for the draw.
 *
 * Rooms are one pool shared by every division drawn together: a room hosts
 * one debate per round overall. Each division gets a fixed slice of the pool,
 * so fixed-room judges keep their room all day. Within its slice a division
 * rotates teams through the rooms so that teams see different rooms.
 */

/** How many rooms one division needs in every round. */
export interface RoomDemand {
  divisionCode: string;
  count: number;
}

/**
 * Orders the pool so that rooms with a fixed panel come first, then by the
 * organiser's sort order, then by id. In per-round mode panels do not follow
 * rooms, so only the sort order matters.
 */
export function preferredRoomOrder(
  rooms: readonly Room[],
  judges: readonly Judge[],
  panelMode: PanelMode,
): Room[] {
  const hasPanel = (room: Room) =>
    panelMode === "fixed-room" && judges.some((judge) => judge.homeRoomId === room.id) ? 0 : 1;
  return [...rooms].sort(
    (a, b) => hasPanel(a) - hasPanel(b) || a.sortOrder - b.sortOrder || compareText(a.id, b.id),
  );
}

/**
 * Splits the pool between the divisions in order. Returns null when the pool
 * is too small for all of them at once.
 */
export function allocateRoomSlices(
  pool: readonly Room[],
  demands: readonly RoomDemand[],
): Map<string, Room[]> | null {
  const needed = demands.reduce((sum, demand) => sum + demand.count, 0);
  if (needed > pool.length) return null;
  const slices = new Map<string, Room[]>();
  let offset = 0;
  for (const demand of demands) {
    slices.set(demand.divisionCode, pool.slice(offset, offset + demand.count));
    offset += demand.count;
  }
  return slices;
}

/**
 * Chooses a room for every pairing in every round. Each round shifts the
 * pairings along the room list by the offset that causes the fewest repeat
 * visits, given the rooms teams have already seen (ported from the prototype).
 * Returns the room id per pairing per round. `rooms` must hold at least as
 * many rooms as there are pairings in a round.
 */
export function rotateRooms(rounds: readonly SidedPair[][], rooms: readonly Room[]): string[][] {
  const visited = new Map<string, Set<string>>();
  const seen = (teamId: string, roomId: string) => visited.get(teamId)?.has(roomId) ?? false;
  const remember = (teamId: string, roomId: string) => {
    const set = visited.get(teamId) ?? new Set<string>();
    set.add(roomId);
    visited.set(teamId, set);
  };

  return rounds.map((pairs) => {
    let bestShift = 0;
    let fewestRepeats = Infinity;
    for (let shift = 0; shift < rooms.length; shift += 1) {
      const repeats = pairs.reduce((sum, pair, index) => {
        const roomId = rooms[(index + shift) % rooms.length].id;
        return (
          sum +
          Number(seen(pair.governmentTeamId, roomId)) +
          Number(seen(pair.oppositionTeamId, roomId))
        );
      }, 0);
      if (repeats < fewestRepeats) {
        fewestRepeats = repeats;
        bestShift = shift;
      }
    }
    return pairs.map((pair, index) => {
      const roomId = rooms[(index + bestShift) % rooms.length].id;
      remember(pair.governmentTeamId, roomId);
      remember(pair.oppositionTeamId, roomId);
      return roomId;
    });
  });
}

/** Counts how often a team returns to a room it has already visited. */
export function countRepeatRoomVisits(
  debates: readonly {
    governmentTeamId: string;
    oppositionTeamId: string;
    roomId: string;
    round: number;
  }[],
): number {
  const visited = new Map<string, Set<string>>();
  let repeats = 0;
  const ordered = [...debates].sort((a, b) => a.round - b.round);
  for (const debate of ordered) {
    for (const teamId of [debate.governmentTeamId, debate.oppositionTeamId]) {
      const rooms = visited.get(teamId) ?? new Set<string>();
      if (rooms.has(debate.roomId)) repeats += 1;
      rooms.add(debate.roomId);
      visited.set(teamId, rooms);
    }
  }
  return repeats;
}
