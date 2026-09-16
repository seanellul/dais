/**
 * Speaking roles in a two-team parliamentary debate: keys, labels, and the
 * mapping between a role and a debater's side and position.
 */
import {
  DEFAULT_ROLE_LABELS,
  type RoleKey,
  type RoleLabels,
  type Side,
  type SpeakerPosition,
} from "@/domain/types";

/** Roles in speaking order. */
export const ROLE_KEYS: RoleKey[] = ["pm", "lo", "gm", "om"];

/** Short labels for tags and tight tables. */
export const ROLE_SHORT: Record<RoleKey, string> = { pm: "PM", lo: "LO", gm: "GM", om: "OM" };

/** Long labels for sides. */
export const SIDE_LABELS: Record<Side, string> = {
  government: "Government",
  opposition: "Opposition",
};

interface RoleSeat {
  side: Side;
  position: SpeakerPosition;
}

const SEAT_OF_ROLE: Record<RoleKey, RoleSeat> = {
  pm: { side: "government", position: 1 },
  gm: { side: "government", position: 2 },
  lo: { side: "opposition", position: 1 },
  om: { side: "opposition", position: 2 },
};

/**
 * The role a debater speaks in. `swapped` is true when the two teammates
 * exchanged roles in the room; the first debater then speaks second.
 */
export function roleFor(side: Side, position: SpeakerPosition, swapped = false): RoleKey {
  const effective: SpeakerPosition = swapped ? (position === 1 ? 2 : 1) : position;
  const entry = (Object.keys(SEAT_OF_ROLE) as RoleKey[]).find((role) => {
    const seat = SEAT_OF_ROLE[role];
    return seat.side === side && seat.position === effective;
  });
  // Every side/position pair is covered above, so `entry` is always found.
  return entry ?? "pm";
}

export function sideOf(role: RoleKey): Side {
  return SEAT_OF_ROLE[role].side;
}

export function positionOf(role: RoleKey): SpeakerPosition {
  return SEAT_OF_ROLE[role].position;
}

/** The label for a role, using the tournament's labels when given. */
export function roleLabel(role: RoleKey, labels: RoleLabels = DEFAULT_ROLE_LABELS): string {
  return labels[role];
}

/** The side a team actually spoke on, given the drawn side and the coin toss. */
export function actualSide(drawnSide: Side, sideFlipped: boolean): Side {
  if (!sideFlipped) return drawnSide;
  return drawnSide === "government" ? "opposition" : "government";
}
