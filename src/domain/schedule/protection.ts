import { compareText } from "../draw/compare";
import type { Assignment, DivisionCode, Schedule } from "../types";
import type { RetiredSlot } from "./assignment-id";
import { canonicalJson } from "./canonical-json";

/**
 * Protection of scored work when setup changes.
 *
 * A division is affected by a setup change when the set of live assignment
 * ids in it changes, or when its roster (teams and debaters) changes. Adding
 * an unused room or judge affects nothing. The service layer uses this to
 * decide which divisions need a reason, an audit row, or a refusal while
 * they are published.
 */

/** The setup before or after a change. */
export interface SetupSnapshot {
  schedule: Schedule;
  assignments: readonly Assignment[];
}

/** The roster fields that matter for scoring, per team. */
export interface RosterEntry {
  id: string;
  code: string;
  name: string;
  school: string;
  seed: number | null;
  speakers: { id: string; name: string }[];
}

/** The division's roster in a stable order, for comparison. */
export function rosterProjection(schedule: Schedule, divisionCode: DivisionCode): RosterEntry[] {
  return schedule.teams
    .filter((team) => team.divisionCode === divisionCode)
    .map((team) => ({
      id: team.id,
      code: team.code,
      name: team.name,
      school: team.school,
      seed: team.seed ?? null,
      speakers: [...team.speakers]
        .sort((a, b) => a.position - b.position)
        .map((speaker) => ({ id: speaker.id, name: speaker.name })),
    }))
    .sort((a, b) => compareText(a.id, b.id));
}

/** Sorted ids of the live assignments in one division. */
export function liveAssignmentIds(
  assignments: readonly Assignment[],
  divisionCode: DivisionCode,
): string[] {
  return assignments
    .filter(
      (assignment) => !assignment.retiredAt && assignment.identity.divisionCode === divisionCode,
    )
    .map((assignment) => assignment.id)
    .sort();
}

/** Divisions whose live assignments or roster differ between the two snapshots, sorted. */
export function affectedDivisions(previous: SetupSnapshot, next: SetupSnapshot): DivisionCode[] {
  const codes = new Set<DivisionCode>([...divisionCodesOf(previous), ...divisionCodesOf(next)]);
  return [...codes]
    .filter(
      (code) =>
        canonicalJson(liveAssignmentIds(previous.assignments, code)) !==
          canonicalJson(liveAssignmentIds(next.assignments, code)) ||
        canonicalJson(rosterProjection(previous.schedule, code)) !==
          canonicalJson(rosterProjection(next.schedule, code)),
    )
    .sort();
}

function divisionCodesOf(snapshot: SetupSnapshot): DivisionCode[] {
  return [
    ...snapshot.schedule.settings.divisions.map((division) => division.code),
    ...snapshot.schedule.teams.map((team) => team.divisionCode),
    ...snapshot.assignments.map((assignment) => assignment.identity.divisionCode),
  ];
}

/**
 * The retired slots that already hold a sheet. The service layer refuses the
 * change, or needs `allowOrphans` with a reason, when this is not empty.
 */
export function scoredSlotsAtRisk(
  retired: readonly RetiredSlot[],
  scoredAssignmentIds: ReadonlySet<string>,
): RetiredSlot[] {
  return retired.filter((slot) => scoredAssignmentIds.has(slot.id));
}
