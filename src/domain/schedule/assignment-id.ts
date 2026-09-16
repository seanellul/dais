import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  Assignment,
  AssignmentDisplay,
  AssignmentIdentity,
  Debate,
  Judge,
  RoleKey,
  Room,
  RoundSetting,
  Schedule,
  Side,
  Speaker,
  SpeakerPosition,
  Team,
} from "../types";
import { canonicalJson } from "./canonical-json";

/**
 * Assignment identity.
 *
 * An assignment is one judge's slot on one debate, and it owns one sheet. Its
 * id is a hash of the fields that define the matchup: debate, round,
 * division, judge, the two teams and the debaters with their positions. When
 * any of those change, the old assignment is retired and a new id is issued,
 * so a sheet scored for the old matchup can never attach to the new one.
 *
 * Display details (names, room name, motion, format) are not part of the
 * identity. Fixing a typo refreshes the display and keeps the id, so a judge
 * with an unsent draft is not disturbed.
 *
 * "Revert does not resurrect": every id issued for a slot is mixed into the
 * next id for that slot. Undoing an edit gives a third id, never the first
 * one back, so a sheet that was set aside stays set aside until an organiser
 * attaches it on purpose.
 */

export const ASSIGNMENT_ID_PREFIX = "asg_";

/** The key of one judge's slot on one debate. */
export function slotKey(debateId: string, judgeId: string): string {
  return `${debateId}:${judgeId}`;
}

/** The speaking role for a side and position: PM, GM, LO or OM. */
export function roleFor(side: Side, position: SpeakerPosition): RoleKey {
  if (side === "government") return position === 1 ? "pm" : "gm";
  return position === 1 ? "lo" : "om";
}

/**
 * 'asg_' + the first 20 hex characters of sha256 over the canonical JSON of
 * [identity, sorted previous ids for the slot, schedule revision].
 */
export function assignmentId(
  identity: AssignmentIdentity,
  previousIdsForSlot: readonly string[],
  revision: number,
): string {
  const material = canonicalJson([identity, [...previousIdsForSlot].sort(), revision]);
  return ASSIGNMENT_ID_PREFIX + bytesToHex(sha256(utf8ToBytes(material))).slice(0, 20);
}

/** Everything a slot points at, resolved. */
interface ResolvedSlot {
  debate: Debate;
  government: Team;
  opposition: Team;
  room: Room;
  judge: Judge;
  round: RoundSetting;
}

/** Resolves a slot's references, or explains which one is missing. */
function resolveSlot(schedule: Schedule, debate: Debate, judgeId: string): ResolvedSlot | string {
  const government = schedule.teams.find((team) => team.id === debate.governmentTeamId);
  const opposition = schedule.teams.find((team) => team.id === debate.oppositionTeamId);
  const room = schedule.rooms.find((candidate) => candidate.id === debate.roomId);
  const judge = schedule.judges.find((candidate) => candidate.id === judgeId);
  const round = schedule.settings.rounds.find((candidate) => candidate.number === debate.round);
  if (!government) return `Government team ${debate.governmentTeamId} is not in the schedule.`;
  if (!opposition) return `Opposition team ${debate.oppositionTeamId} is not in the schedule.`;
  if (!room) return `Room ${debate.roomId} is not in the schedule.`;
  if (!judge) return `Judge ${judgeId} is not in the schedule.`;
  if (!round) return `Round ${debate.round} is not in the tournament settings.`;
  return { debate, government, opposition, room, judge, round };
}

function orderedSpeakers(team: Team): Speaker[] {
  return [...team.speakers].sort((a, b) => a.position - b.position);
}

/**
 * The matchup-defining fields of one judge's slot. Throws when the debate
 * points at a team, room, judge or round that is not in the schedule, so
 * validate the schedule first.
 */
export function identityOf(
  schedule: Schedule,
  debate: Debate,
  judgeId: string,
): AssignmentIdentity {
  const slot = resolveSlot(schedule, debate, judgeId);
  if (typeof slot === "string") throw new Error(slot);
  return buildIdentity(slot);
}

/** The refreshable details shown on the judge's sheet. Same preconditions as identityOf. */
export function displayOf(schedule: Schedule, debate: Debate, judgeId: string): AssignmentDisplay {
  const slot = resolveSlot(schedule, debate, judgeId);
  if (typeof slot === "string") throw new Error(slot);
  return buildDisplay(slot);
}

function buildIdentity(slot: ResolvedSlot): AssignmentIdentity {
  const speakersOf = (team: Team, side: Side) =>
    orderedSpeakers(team).map((speaker) => ({
      id: speaker.id,
      teamId: team.id,
      side,
      position: speaker.position,
    }));
  return {
    debateId: slot.debate.id,
    divisionCode: slot.debate.divisionCode,
    round: slot.debate.round,
    judgeId: slot.judge.id,
    governmentTeamId: slot.government.id,
    oppositionTeamId: slot.opposition.id,
    speakers: [
      ...speakersOf(slot.government, "government"),
      ...speakersOf(slot.opposition, "opposition"),
    ],
  };
}

function buildDisplay(slot: ResolvedSlot): AssignmentDisplay {
  const teamCard = (team: Team) => ({
    teamId: team.id,
    code: team.code,
    name: team.name,
    school: team.school,
  });
  const speakersOf = (team: Team, side: Side) =>
    orderedSpeakers(team).map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      teamId: team.id,
      side,
      position: speaker.position,
      role: roleFor(side, speaker.position),
    }));
  return {
    roomName: slot.room.name,
    judgeName: slot.judge.name,
    roundFormat: slot.round.format,
    sidesDecided: slot.round.sidesDecided,
    motion: slot.debate.motion ?? "",
    government: teamCard(slot.government),
    opposition: teamCard(slot.opposition),
    speakers: [
      ...speakersOf(slot.government, "government"),
      ...speakersOf(slot.opposition, "opposition"),
    ],
  };
}

/** An assignment that stops being live after a schedule change. */
export interface RetiredSlot {
  id: string;
  /** The new assignment for the same slot, or null when the slot went away. */
  successorId: string | null;
  reason: "matchup-changed" | "slot-removed";
}

/** A slot the derivation could not resolve, so it is neither live nor retired. */
export interface SkippedSlot {
  debateId: string;
  judgeId: string;
  /** Which reference is missing, e.g. "Room room-99 is not in the schedule." */
  reason: string;
  /** The previous live assignment for this slot, if there was one. */
  previousId: string | null;
}

export interface DeriveResult {
  /** Every live assignment for the schedule, in debate then seat order. */
  assignments: Assignment[];
  retired: RetiredSlot[];
  /**
   * Slots whose debate points at a team, room, judge or round that is not in
   * the schedule. Empty for a schedule without blockers. A skipped slot is
   * left exactly as it was: it is in neither `assignments` nor `retired`, and
   * `previousId` names its live assignment so a service can decide. Once the
   * reference is repaired and the identity is unchanged, the slot keeps its id.
   */
  skipped: SkippedSlot[];
}

/**
 * Derives the live assignments for a schedule from the previous ones.
 *
 * - A slot whose identity is unchanged keeps its id and gets a refreshed
 *   display and schedule revision.
 * - A slot whose identity changed gets a new id; the old one is retired with
 *   the new id as its successor.
 * - A previous live slot that no longer exists is retired with no successor.
 * - A slot with a broken reference is skipped, not retired (see `skipped`).
 *
 * `previous` may include retired assignments; their ids still feed the hash
 * for the slot so that no old id can come back.
 */
export function deriveAssignments(
  schedule: Schedule,
  previous: readonly Assignment[] = [],
): DeriveResult {
  const live = new Map<string, Assignment>();
  const idsBySlot = new Map<string, string[]>();
  for (const assignment of previous) {
    const key = slotKey(assignment.identity.debateId, assignment.identity.judgeId);
    idsBySlot.set(key, [...(idsBySlot.get(key) ?? []), assignment.id]);
    if (!assignment.retiredAt && !live.has(key)) live.set(key, assignment);
  }

  const assignments: Assignment[] = [];
  const retired: RetiredSlot[] = [];
  const skipped: SkippedSlot[] = [];
  /** Every slot met in the schedule, resolved or skipped: none of these is "removed". */
  const seen = new Set<string>();

  for (const debate of schedule.debates) {
    for (const judgeId of debate.judgeIds) {
      const key = slotKey(debate.id, judgeId);
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = resolveSlot(schedule, debate, judgeId);
      if (typeof slot === "string") {
        skipped.push({
          debateId: debate.id,
          judgeId,
          reason: slot,
          previousId: live.get(key)?.id ?? null,
        });
        continue;
      }
      const identity = buildIdentity(slot);
      const display = buildDisplay(slot);
      const current = live.get(key);
      if (current && canonicalJson(current.identity) === canonicalJson(identity)) {
        assignments.push({
          ...current,
          identity,
          display,
          scheduleRevision: schedule.revision,
          retiredAt: null,
          retiredReason: null,
          successorId: null,
        });
        continue;
      }
      const id = assignmentId(identity, idsBySlot.get(key) ?? [], schedule.revision);
      assignments.push({
        id,
        identity,
        display,
        scheduleRevision: schedule.revision,
        retiredAt: null,
        retiredReason: null,
        successorId: null,
      });
      if (current) retired.push({ id: current.id, successorId: id, reason: "matchup-changed" });
    }
  }

  for (const [key, current] of live) {
    if (!seen.has(key)) retired.push({ id: current.id, successorId: null, reason: "slot-removed" });
  }
  return { assignments, retired, skipped };
}
