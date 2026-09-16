import { MAX_PANEL_SIZE } from "../draw/panels";
import type { Debate, DivisionCode, Room, Schedule, Team, TournamentSettings } from "../types";

/**
 * Schedule validation, ported rule for rule from the prototype.
 *
 * Two modes:
 * - draft (default): the schedule may be incomplete, but nothing in it may be
 *   contradictory (unknown references, double bookings, repeat opponents).
 * - requireComplete: every active team must debate in every round and, when
 *   at least two rounds have sides decided in advance, on each side at least
 *   once across those rounds.
 *
 * This module never throws. Every problem is an issue with a plain message
 * and the setup tab where the organiser can fix it.
 */

export type IssueTab = "teams" | "judges" | "rooms" | "draw";
export type IssueSeverity = "blocker" | "warning";

export interface ScheduleIssue {
  /** A stable machine code, e.g. "round.room-double-booked". */
  code: string;
  /** Plain words for the organiser. */
  message: string;
  /** The setup tab where the organiser can fix it. */
  tab: IssueTab;
  round?: number;
  /** Set when the issue belongs to one division; absent when it is tournament-wide. */
  divisionCode?: DivisionCode;
  severity: IssueSeverity;
}

export interface ValidateOptions {
  /** Also require every team in every round, and balanced sides. */
  requireComplete?: boolean;
  /** Limit the result to this division's issues plus tournament-wide ones. */
  divisionCode?: DivisionCode;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ScheduleIssue[] };

export const MIN_TEAMS_PER_DIVISION = 4;
export const DEBATERS_PER_TEAM = 2;
export { MAX_PANEL_SIZE };

/** Validates the schedule. `ok` is false when there is at least one blocker or warning. */
export function validateSchedule(
  schedule: Schedule,
  options: ValidateOptions = {},
): ValidationResult {
  const issues = scheduleIssues(schedule, options);
  return issues.length ? { ok: false, issues } : { ok: true };
}

/** True when nothing stops the schedule from being published; warnings are allowed. */
export function hasBlockers(issues: readonly ScheduleIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocker");
}

/** The same rules as validateSchedule, as a flat list. */
export function scheduleIssues(schedule: Schedule, options: ValidateOptions = {}): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const add = (issue: ScheduleIssue) => issues.push(issue);
  const index = indexSchedule(schedule);

  checkUniqueIds(schedule, add);
  checkTeams(schedule, index, add);
  checkJudges(schedule, index, add);
  checkRooms(schedule, add);
  const book = checkDebates(schedule, index, add);
  if (options.requireComplete) {
    checkComplete(schedule, index, book, options.divisionCode, add);
  }

  if (options.divisionCode === undefined) return issues;
  return issues.filter(
    (issue) => issue.divisionCode === undefined || issue.divisionCode === options.divisionCode,
  );
}

/**
 * Side-balance issues for one division: with at least two rounds decided in
 * advance, every active team must be Government at least once and Opposition
 * at least once across those rounds. Shared with the readiness checklist.
 */
export function sideBalanceIssues(schedule: Schedule, divisionCode: DivisionCode): ScheduleIssue[] {
  const index = indexSchedule(schedule);
  const book = bookDebates(schedule, index);
  const issues: ScheduleIssue[] = [];
  addSideBalanceIssues(schedule, book, divisionCode, (issue) => issues.push(issue));
  return issues;
}

// ---------------------------------------------------------------------------
// Lookups

interface ScheduleIndex {
  teams: Map<string, Team>;
  rooms: Map<string, Room>;
  judgeNames: Map<string, string>;
  divisionCodes: Set<DivisionCode>;
  roundNumbers: Set<number>;
}

function indexSchedule(schedule: Schedule): ScheduleIndex {
  return {
    teams: new Map(schedule.teams.map((team) => [team.id, team])),
    rooms: new Map(schedule.rooms.map((room) => [room.id, room])),
    judgeNames: new Map(schedule.judges.map((judge) => [judge.id, judge.name])),
    divisionCodes: new Set(schedule.settings.divisions.map((division) => division.code)),
    roundNumbers: new Set(schedule.settings.rounds.map((round) => round.number)),
  };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** "Coral Bay Compass (O07)" for messages; falls back to whatever the team has. */
export function teamLabel(team: Pick<Team, "code" | "name">): string {
  if (hasText(team.name) && hasText(team.code)) return `${team.name} (${team.code})`;
  return hasText(team.name) ? team.name : team.code || "A team";
}

export function divisionName(settings: TournamentSettings, code: DivisionCode): string {
  return settings.divisions.find((division) => division.code === code)?.name ?? code;
}

/**
 * "Round 2 in Debate Room 4". Without a known room: "Round 2: O03 v O06",
 * or the debate id when the teams are unknown too.
 */
function describeDebate(debate: Debate, room: Room | undefined, index: ScheduleIndex): string {
  if (room) return `Round ${debate.round} in ${room.name}`;
  const government = index.teams.get(debate.governmentTeamId);
  const opposition = index.teams.get(debate.oppositionTeamId);
  if (government && opposition)
    return `Round ${debate.round}: ${government.code} v ${opposition.code}`;
  return `Round ${debate.round}: debate ${debate.id}`;
}

// ---------------------------------------------------------------------------
// Shape and identity rules

function checkUniqueIds(schedule: Schedule, add: (issue: ScheduleIssue) => void): void {
  const unique = (values: unknown[], code: string, message: string, tab: IssueTab) => {
    if (new Set(values).size !== values.length) add({ code, message, tab, severity: "blocker" });
  };
  unique(
    schedule.teams.map((team) => team.id),
    "team.duplicate-id",
    "Team IDs must be unique.",
    "teams",
  );
  unique(
    schedule.judges.map((judge) => judge.id),
    "judge.duplicate-id",
    "Judge IDs must be unique.",
    "judges",
  );
  unique(
    schedule.rooms.map((room) => room.id),
    "room.duplicate-id",
    "Room IDs must be unique.",
    "rooms",
  );
  unique(
    schedule.debates.map((debate) => debate.id),
    "debate.duplicate-id",
    "Debate IDs must be unique.",
    "draw",
  );
  const speakerIds = schedule.teams.flatMap((team) =>
    (team.speakers ?? []).map((speaker) => speaker.id),
  );
  unique(speakerIds, "debater.duplicate-id", "Debater IDs must be unique.", "teams");
  const codes = schedule.teams.map((team) =>
    String(team.code ?? "")
      .trim()
      .toLowerCase(),
  );
  unique(codes, "team.duplicate-code", "Team codes must be unique.", "teams");
  const names = schedule.teams.map(
    (team) =>
      `${team.divisionCode}:${String(team.name ?? "")
        .trim()
        .toLowerCase()}`,
  );
  unique(names, "team.duplicate-name", "Team names within each division must be unique.", "teams");
}

function checkTeams(
  schedule: Schedule,
  index: ScheduleIndex,
  add: (issue: ScheduleIssue) => void,
): void {
  for (const team of schedule.teams) {
    const divisionCode = hasText(team.divisionCode) ? team.divisionCode : undefined;
    if (![team.id, team.code, team.name, team.school, team.divisionCode].every(hasText)) {
      add({
        code: "team.incomplete",
        message: "Every team needs an ID, a code, a name, a school and a division.",
        tab: "teams",
        divisionCode,
        severity: "blocker",
      });
      continue;
    }
    if (!index.divisionCodes.has(team.divisionCode)) {
      add({
        code: "team.unknown-division",
        message: `Team ${team.code} is in division "${team.divisionCode}", which is not in the tournament settings.`,
        tab: "teams",
        divisionCode,
        severity: "blocker",
      });
    }
    checkDebaters(team, add);
  }
}

function checkDebaters(team: Team, add: (issue: ScheduleIssue) => void): void {
  const speakers = Array.isArray(team.speakers) ? team.speakers : [];
  const positions = speakers.map((speaker) => speaker.position);
  const wellFormed =
    speakers.length >= 1 &&
    speakers.length <= DEBATERS_PER_TEAM &&
    speakers.every(
      (speaker) =>
        hasText(speaker.id) &&
        hasText(speaker.name) &&
        (speaker.position === 1 || speaker.position === 2),
    ) &&
    new Set(positions).size === positions.length;
  if (!wellFormed) {
    add({
      code: "team.debaters",
      message: `Team ${team.code} needs two named debaters, one in position 1 and one in position 2.`,
      tab: "teams",
      divisionCode: team.divisionCode,
      severity: "blocker",
    });
    return;
  }
  if (speakers.length < DEBATERS_PER_TEAM) {
    add({
      code: "team.one-debater",
      message: `Team ${team.code} has only one debater.`,
      tab: "teams",
      divisionCode: team.divisionCode,
      severity: "warning",
    });
  }
}

function checkJudges(
  schedule: Schedule,
  index: ScheduleIndex,
  add: (issue: ScheduleIssue) => void,
): void {
  for (const judge of schedule.judges) {
    if (![judge.id, judge.name].every(hasText)) {
      add({
        code: "judge.incomplete",
        message: "Every judge needs an ID and a name.",
        tab: "judges",
        severity: "blocker",
      });
      continue;
    }
    if (judge.homeRoomId && !index.rooms.has(judge.homeRoomId)) {
      add({
        code: "judge.unknown-room",
        message: `Judge ${judge.name} is allocated to an unknown room.`,
        tab: "judges",
        severity: "blocker",
      });
    }
  }
}

function checkRooms(schedule: Schedule, add: (issue: ScheduleIssue) => void): void {
  if (schedule.rooms.some((room) => !hasText(room.id) || !hasText(room.name))) {
    add({
      code: "room.incomplete",
      message: "Every room needs an ID and a name.",
      tab: "rooms",
      severity: "blocker",
    });
  }
}

// ---------------------------------------------------------------------------
// Debate rules

/** What the debate pass learns, reused by the completeness checks. */
interface DrawBook {
  /** "division:round:teamId" for every appearance. */
  teamRounds: Set<string>;
  /** teamId -> rounds in which the team was Government. */
  governmentRounds: Map<string, Set<number>>;
}

function bookDebates(schedule: Schedule, index: ScheduleIndex): DrawBook {
  const book: DrawBook = { teamRounds: new Set(), governmentRounds: new Map() };
  for (const debate of schedule.debates) {
    const government = index.teams.get(debate.governmentTeamId);
    const opposition = index.teams.get(debate.oppositionTeamId);
    if (!government || !opposition) continue;
    book.teamRounds.add(`${debate.divisionCode}:${debate.round}:${government.id}`);
    book.teamRounds.add(`${debate.divisionCode}:${debate.round}:${opposition.id}`);
    const rounds = book.governmentRounds.get(government.id) ?? new Set<number>();
    rounds.add(debate.round);
    book.governmentRounds.set(government.id, rounds);
  }
  return book;
}

function checkDebates(
  schedule: Schedule,
  index: ScheduleIndex,
  add: (issue: ScheduleIssue) => void,
): DrawBook {
  const fixedRooms = schedule.settings.panelMode === "fixed-room";
  const roomBookings = new Map<string, Debate>();
  const judgeBookings = new Map<string, Debate>();
  const judgeRooms = new Map<string, string>();
  const pairings = new Map<string, Debate>();
  const seenTeams = new Map<string, Debate>();
  if (fixedRooms) {
    for (const judge of schedule.judges)
      if (judge.homeRoomId) judgeRooms.set(judge.id, judge.homeRoomId);
  }

  for (const debate of schedule.debates) {
    const divisionCode = hasText(debate.divisionCode) ? debate.divisionCode : undefined;
    const blocker = (code: string, message: string, tab: IssueTab = "draw") =>
      add({ code, message, tab, round: debate.round, divisionCode, severity: "blocker" });
    const warning = (code: string, message: string) =>
      add({ code, message, tab: "draw", round: debate.round, divisionCode, severity: "warning" });

    if (
      !hasText(debate.id) ||
      !index.divisionCodes.has(debate.divisionCode) ||
      typeof debate.motion !== "string"
    ) {
      blocker(
        "debate.incomplete",
        "Every debate needs an ID, a division from the tournament settings and a motion, which may be left blank.",
      );
      continue;
    }
    if (!index.roundNumbers.has(debate.round)) {
      blocker(
        "debate.unknown-round",
        `Round ${debate.round} is not one of the tournament's rounds; add it in Settings or remove its debates.`,
      );
      continue;
    }

    const room = index.rooms.get(debate.roomId);
    const where = describeDebate(debate, room, index);
    if (!room)
      blocker(
        "debate.unknown-room",
        `${where} is in a room that no longer exists; pick a room in the Draw.`,
      );

    const government = index.teams.get(debate.governmentTeamId);
    const opposition = index.teams.get(debate.oppositionTeamId);
    if (!government || !opposition || government.id === opposition.id) {
      blocker("debate.invalid-teams", `${where} references invalid teams.`);
    } else {
      checkDebateTeams(
        debate,
        where,
        government,
        opposition,
        seenTeams,
        pairings,
        blocker,
        warning,
      );
    }

    checkPanel(schedule, index, debate, where, judgeRooms, judgeBookings, fixedRooms, add);

    if (room) {
      const key = `${debate.round}:${room.id}`;
      const earlier = roomBookings.get(key);
      if (earlier) {
        add({
          code: "round.room-double-booked",
          message: `${room.name} is booked twice in round ${debate.round}.`,
          tab: "draw",
          round: debate.round,
          divisionCode: earlier.divisionCode === debate.divisionCode ? divisionCode : undefined,
          severity: "blocker",
        });
      } else {
        roomBookings.set(key, debate);
      }
    }
  }
  return bookDebates(schedule, index);
}

function checkDebateTeams(
  debate: Debate,
  where: string,
  government: Team,
  opposition: Team,
  seenTeams: Map<string, Debate>,
  pairings: Map<string, Debate>,
  blocker: (code: string, message: string) => void,
  warning: (code: string, message: string) => void,
): void {
  if (
    government.divisionCode !== debate.divisionCode ||
    opposition.divisionCode !== debate.divisionCode
  ) {
    blocker("debate.other-division", `${where} uses a team from another division.`);
  }
  for (const team of [government, opposition]) {
    if (team.status === "withdrawn") {
      warning(
        "debate.withdrawn-team",
        `Team ${team.code} has withdrawn but is still in the draw for round ${debate.round}.`,
      );
    }
    const key = `${debate.divisionCode}:${debate.round}:${team.id}`;
    if (seenTeams.has(key)) {
      blocker(
        "round.team-twice",
        `Team ${team.code} appears more than once in round ${debate.round}.`,
      );
    }
    seenTeams.set(key, debate);
  }
  const pairKey = [government.id, opposition.id].sort().join(":");
  if (pairings.has(pairKey)) {
    blocker(
      "draw.repeat-opponents",
      `Teams ${government.code} and ${opposition.code} meet more than once.`,
    );
  }
  pairings.set(pairKey, debate);
}

function checkPanel(
  schedule: Schedule,
  index: ScheduleIndex,
  debate: Debate,
  where: string,
  judgeRooms: Map<string, string>,
  judgeBookings: Map<string, Debate>,
  fixedRooms: boolean,
  add: (issue: ScheduleIssue) => void,
): void {
  const divisionCode = debate.divisionCode;
  const issue = (
    code: string,
    message: string,
    tab: IssueTab,
    severity: IssueSeverity,
    shared = false,
  ) =>
    add({
      code,
      message,
      tab,
      round: debate.round,
      divisionCode: shared ? undefined : divisionCode,
      severity,
    });
  const judgeIds = debate.judgeIds;

  if (
    !Array.isArray(judgeIds) ||
    judgeIds.length < 1 ||
    judgeIds.length > MAX_PANEL_SIZE ||
    judgeIds.some((id) => !hasText(id))
  ) {
    issue("debate.panel-size", `${where} needs one to five judges.`, "judges", "blocker");
    return;
  }
  if (new Set(judgeIds).size !== judgeIds.length) {
    issue("debate.duplicate-judge", `${where} lists the same judge twice.`, "judges", "blocker");
  }
  for (const judgeId of new Set(judgeIds)) {
    const name = index.judgeNames.get(judgeId);
    if (name === undefined) {
      issue("debate.unknown-judge", `${where} references an unknown judge.`, "judges", "blocker");
      continue;
    }
    const judge = schedule.judges.find((candidate) => candidate.id === judgeId);
    if (judge?.status === "withdrawn") {
      issue(
        "debate.withdrawn-judge",
        `${name} has withdrawn but is still on a panel in round ${debate.round}.`,
        "judges",
        "warning",
      );
    }
    if (fixedRooms) {
      const knownRoom = judgeRooms.get(judgeId);
      if (knownRoom !== undefined && knownRoom !== debate.roomId) {
        issue(
          "judge.room-changed",
          `${name} sits in more than one room. Judges stay in their allocated room for all rounds; change the room allocation in Judges.`,
          "judges",
          "blocker",
          true,
        );
      }
      judgeRooms.set(judgeId, debate.roomId);
    }
    const key = `${debate.round}:${judgeId}`;
    const earlier = judgeBookings.get(key);
    if (earlier) {
      issue(
        "round.judge-double-booked",
        `${name} is on two panels in round ${debate.round}.`,
        "draw",
        "blocker",
        earlier.divisionCode !== debate.divisionCode,
      );
    } else {
      judgeBookings.set(key, debate);
    }
  }
}

// ---------------------------------------------------------------------------
// Completeness rules

function checkComplete(
  schedule: Schedule,
  index: ScheduleIndex,
  book: DrawBook,
  divisionCode: DivisionCode | undefined,
  add: (issue: ScheduleIssue) => void,
): void {
  const targets =
    divisionCode !== undefined ? [divisionCode] : schedule.settings.divisions.map((d) => d.code);
  const rounds = [...schedule.settings.rounds].sort((a, b) => a.number - b.number);
  for (const code of targets) {
    const teams = schedule.teams.filter(
      (team) => team.divisionCode === code && team.status === "active",
    );
    for (const round of rounds) {
      for (const team of teams) {
        if (book.teamRounds.has(`${code}:${round.number}:${team.id}`)) continue;
        add({
          code: "draw.missing-team",
          message: `${divisionName(schedule.settings, code)} round ${round.number} is missing team ${teamLabel(team)}.`,
          tab: "draw",
          round: round.number,
          divisionCode: code,
          severity: "blocker",
        });
      }
    }
    addSideBalanceIssues(schedule, book, code, add);
  }
}

function addSideBalanceIssues(
  schedule: Schedule,
  book: DrawBook,
  divisionCode: DivisionCode,
  add: (issue: ScheduleIssue) => void,
): void {
  const advanceRounds = schedule.settings.rounds
    .filter((round) => round.sidesDecided === "in-advance")
    .map((round) => round.number);
  if (advanceRounds.length < 2) return;
  const teams = schedule.teams.filter(
    (team) => team.divisionCode === divisionCode && team.status === "active",
  );
  for (const team of teams) {
    const government = book.governmentRounds.get(team.id) ?? new Set<number>();
    const asGovernment = advanceRounds.filter((round) => government.has(round)).length;
    if (asGovernment >= 1 && asGovernment <= advanceRounds.length - 1) continue;
    add({
      code: "draw.sides-unbalanced",
      message: `${teamLabel(team)} must debate on each side at least once.`,
      tab: "draw",
      divisionCode,
      severity: "blocker",
    });
  }
}
