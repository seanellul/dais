import { preferredRoomOrder } from "../draw/rooms";
import type { Debate, DivisionCode, Judge, Room, Schedule, Team } from "../types";
import {
  MAX_PANEL_SIZE,
  MIN_TEAMS_PER_DIVISION,
  scheduleIssues,
  sideBalanceIssues,
  teamLabel,
  type IssueTab,
  type ScheduleIssue,
} from "./validate";

/**
 * The dashboard checklist for one division: everything that still needs
 * attention before the draw can be published, in the order the organiser
 * works through setup (Teams, Judges, Rooms, Draw). An empty list means the
 * division is ready.
 *
 * The list combines the validation rules with the prototype's readiness
 * rules, scoped so that a complete, sound draw is quiet:
 * - Team-count and judge-pool rules run only before the division is drawn.
 *   Once it is drawn, a withdrawn team is reported on the debate it leaves
 *   short, with the opponent named.
 * - Fixed-room panel rules look only at the rooms the division uses (or,
 *   before the draw, the rooms the draw would pick), and count judges the
 *   draw seated as allocated.
 * Duplicate messages are removed.
 */
export function readiness(schedule: Schedule, divisionCode: DivisionCode): ScheduleIssue[] {
  const issues = [
    // The draw-tab rule below replaces validation's withdrawn-team warning and names the opponent.
    ...scheduleIssues(schedule, { divisionCode }).filter(
      (issue) => issue.code !== "debate.withdrawn-team",
    ),
    ...readinessIssues(schedule, divisionCode),
  ];
  return sortIssues(dedupeByMessage(issues));
}

const TAB_ORDER: IssueTab[] = ["teams", "judges", "rooms", "draw"];

/** Tab order, then round, then blockers before warnings. Stable otherwise. */
export function sortIssues(issues: readonly ScheduleIssue[]): ScheduleIssue[] {
  return [...issues].sort(
    (a, b) =>
      TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab) ||
      (a.round ?? 0) - (b.round ?? 0) ||
      Number(a.severity === "warning") - Number(b.severity === "warning"),
  );
}

/** Keeps the first issue for each message. */
export function dedupeByMessage(issues: readonly ScheduleIssue[]): ScheduleIssue[] {
  const byMessage = new Map<string, ScheduleIssue>();
  for (const issue of issues)
    if (!byMessage.has(issue.message)) byMessage.set(issue.message, issue);
  return [...byMessage.values()];
}

type Add = (issue: ScheduleIssue) => void;

function readinessIssues(schedule: Schedule, divisionCode: DivisionCode): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const add: Add = (issue) => issues.push(issue);
  const teams = activeTeams(schedule, divisionCode);
  const debates = schedule.debates.filter((debate) => debate.divisionCode === divisionCode);
  const drawn = debates.length > 0;

  if (drawn) {
    checkWithdrawnTeams(schedule, debates, add);
  } else {
    checkTeamCount(teams.length, divisionCode, add);
    if (schedule.settings.panelMode === "per-round") checkJudgePool(schedule, add);
  }
  if (schedule.settings.panelMode === "fixed-room") {
    checkFixedPanels(schedule, roomsInScope(schedule, divisionCode, teams, debates), add);
  }
  const complete = checkRounds(schedule, divisionCode, teams, debates, add);
  if (complete) sideBalanceIssues(schedule, divisionCode).forEach(add);
  return issues;
}

function activeTeams(schedule: Schedule, divisionCode: DivisionCode): Team[] {
  return schedule.teams.filter(
    (team) => team.divisionCode === divisionCode && team.status === "active",
  );
}

function activeJudges(schedule: Schedule): Judge[] {
  return schedule.judges.filter((judge) => judge.status === "active");
}

// ---------------------------------------------------------------------------
// Before the draw

function checkTeamCount(count: number, divisionCode: DivisionCode, add: Add): void {
  if (count < MIN_TEAMS_PER_DIVISION) {
    const missing = MIN_TEAMS_PER_DIVISION - count;
    add({
      code: "division.too-few-teams",
      message: `${count === 1 ? "1 team is" : `${count} teams are`} listed; add ${missing} more to reach the four-team minimum.`,
      tab: "teams",
      divisionCode,
      severity: "blocker",
    });
  } else if (count % 2 !== 0) {
    add({
      code: "division.odd-teams",
      message: "Add one more team so the division has an even number of teams.",
      tab: "teams",
      divisionCode,
      severity: "blocker",
    });
  }
}

/** Rooms needed at once: every division debates in the same round, so their needs add up. */
function roomsNeededAtOnce(schedule: Schedule): number {
  return schedule.settings.divisions.reduce(
    (sum, division) => sum + Math.ceil(activeTeams(schedule, division.code).length / 2),
    0,
  );
}

/** Per-round mode: is the judge pool big enough for every room in every round? */
function checkJudgePool(schedule: Schedule, add: Add): void {
  const judges = activeJudges(schedule).length;
  const rooms = roomsNeededAtOnce(schedule);
  if (rooms === 0) return;
  const perRoom = Math.max(1, Math.floor(schedule.settings.judgesPerRoom) || 1);
  const listed = judges === 1 ? "1 judge is listed" : `${judges} judges are listed`;
  if (judges < rooms) {
    add({
      code: "judges.too-few",
      message: `${listed}; ${rooms} rooms need at least one judge each.`,
      tab: "judges",
      severity: "blocker",
    });
  } else if (judges < rooms * perRoom) {
    add({
      code: "judges.short",
      message: `${listed}; ${rooms} rooms with ${perRoom} judges each need ${rooms * perRoom}.`,
      tab: "judges",
      severity: "warning",
    });
  }
}

// ---------------------------------------------------------------------------
// Fixed-room panels

/**
 * The rooms this division uses: the rooms of its debates once it is drawn,
 * otherwise the rooms the draw would pick (rooms with a panel first, minus
 * rooms other divisions already use).
 */
function roomsInScope(
  schedule: Schedule,
  divisionCode: DivisionCode,
  teams: Team[],
  debates: Debate[],
): Room[] {
  const byId = new Map(schedule.rooms.map((room) => [room.id, room]));
  if (debates.length) {
    const ids = [...new Set(debates.map((debate) => debate.roomId))];
    return ids.map((id) => byId.get(id)).filter((room): room is Room => room !== undefined);
  }
  const usedElsewhere = new Set(
    schedule.debates
      .filter((debate) => debate.divisionCode !== divisionCode)
      .map((debate) => debate.roomId),
  );
  const free = schedule.rooms.filter((room) => !usedElsewhere.has(room.id));
  const needed = Math.ceil(teams.length / 2);
  return preferredRoomOrder(free, activeJudges(schedule), schedule.settings.panelMode).slice(
    0,
    needed,
  );
}

/**
 * Every room in scope needs a panel: judges allocated to it, or judges the
 * draw seated there. Judges with no room are only worth a warning while a
 * room still has no panel.
 */
function checkFixedPanels(schedule: Schedule, rooms: readonly Room[], add: Add): void {
  const judges = activeJudges(schedule);
  const seated = new Set(schedule.debates.flatMap((debate) => debate.judgeIds));
  const allocatedTo = (room: Room) => judges.filter((judge) => judge.homeRoomId === room.id).length;
  const seatedIn = (room: Room) =>
    schedule.debates.some((debate) => debate.roomId === room.id && debate.judgeIds.length > 0);
  const withoutPanel = rooms.filter((room) => allocatedTo(room) === 0 && !seatedIn(room));
  const unallocated = judges.filter((judge) => !judge.homeRoomId && !seated.has(judge.id)).length;

  if (unallocated && withoutPanel.length) {
    add({
      code: "judges.unallocated",
      message: `${unallocated === 1 ? "1 judge is" : `${unallocated} judges are`} not allocated to a room yet.`,
      tab: "judges",
      severity: "warning",
    });
  }
  for (const room of withoutPanel) {
    add({
      code: "room.no-panel",
      message: `${room.name} has no judges allocated yet.`,
      tab: "judges",
      severity: "warning",
    });
  }
  for (const room of rooms) {
    const allocated = allocatedTo(room);
    if (allocated > MAX_PANEL_SIZE) {
      add({
        code: "room.panel-too-big",
        message: `${room.name} has ${allocated} judges allocated; panels allow at most five.`,
        tab: "judges",
        severity: "blocker",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// After the draw

/** A debate that still lists a withdrawn team cannot run; say which opponent is left. */
function checkWithdrawnTeams(schedule: Schedule, debates: readonly Debate[], add: Add): void {
  const teams = new Map(schedule.teams.map((team) => [team.id, team]));
  const rooms = new Map(schedule.rooms.map((room) => [room.id, room]));
  for (const debate of debates) {
    const government = teams.get(debate.governmentTeamId);
    const opposition = teams.get(debate.oppositionTeamId);
    const room = rooms.get(debate.roomId);
    const where = room ? `Round ${debate.round} in ${room.name}` : `Round ${debate.round}`;
    for (const [team, other] of [
      [government, opposition],
      [opposition, government],
    ]) {
      if (team?.status !== "withdrawn") continue;
      const left = other ? teamLabel(other) : "its opponent";
      add({
        code: "draw.withdrawn-team",
        message: `${where}: ${teamLabel(team)} has withdrawn; give ${left} a new opponent or take the debate out of the draw.`,
        tab: "draw",
        round: debate.round,
        divisionCode: debate.divisionCode,
        severity: "blocker",
      });
    }
  }
}

/** Debates per round and missing teams. Returns true when every round is fully drawn. */
function checkRounds(
  schedule: Schedule,
  divisionCode: DivisionCode,
  teams: Schedule["teams"],
  debates: Schedule["debates"],
  add: Add,
): boolean {
  const drawable = teams.length >= MIN_TEAMS_PER_DIVISION && teams.length % 2 === 0;
  const expected = teams.length / 2;
  let complete = drawable;
  const rounds = [...schedule.settings.rounds].sort((a, b) => a.number - b.number);
  for (const { number } of rounds) {
    const inRound = debates.filter((debate) => debate.round === number);
    if (drawable && inRound.length !== expected) {
      complete = false;
      add({
        code: "round.debate-count",
        message: `Round ${number} has ${inRound.length === 1 ? "1 debate" : `${inRound.length} debates`}; expected ${expected}.`,
        tab: "draw",
        round: number,
        divisionCode,
        severity: "blocker",
      });
    }
    if (inRound.length === 0) continue;
    const seen = new Set(
      inRound.flatMap((debate) => [debate.governmentTeamId, debate.oppositionTeamId]),
    );
    for (const team of teams) {
      if (seen.has(team.id)) continue;
      complete = false;
      add({
        code: "draw.missing-team",
        message: `${teamLabel(team)} is missing from round ${number}.`,
        tab: "draw",
        round: number,
        divisionCode,
        severity: "blocker",
      });
    }
  }
  return complete && rounds.length > 0;
}
