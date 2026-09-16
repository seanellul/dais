import type { Assignment, Schedule, Team } from "@/domain/types";
import type { DivisionResultsLike, SheetRecord } from "@/domain/export/rows";
import { WORKBOOK_POLICY, type DivisionInput, type ScoreSource } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";

function team(code: string, name: string, school: string, first: string, second: string): Team {
  return {
    id: `team-${code.toLowerCase()}`,
    divisionCode: code.startsWith("O") ? "Open" : "Novice",
    code,
    name,
    school,
    seed: null,
    speakers: [
      { id: `spk-${code.toLowerCase()}-1`, name: first, position: 1 },
      { id: `spk-${code.toLowerCase()}-2`, name: second, position: 2 },
    ],
    status: "active",
  };
}

export const SCHEDULE: Schedule = {
  settings: DEFAULT_SETTINGS,
  teams: [
    team("O01", "=Compass", "Coral Bay Academy", "Amara Bennett", "Theo Campbell"),
    team("O02", "Lantern", "Harbourview College", "Leila Foster", "Marcus Grant"),
    team("N01", "Marlins", "Silver Palm High", "Nadia Hall", "Elias James"),
    team("N02", "Wayfinders", "Horizon International", "Sofia Khan", "Jonah Lewis"),
  ],
  judges: [
    { id: "judge-01", name: "Marisol Blake", homeRoomId: "room-01", status: "active" },
    { id: "judge-02", name: "Cedric Bowen", homeRoomId: "room-02", status: "active" },
  ],
  rooms: [
    { id: "room-02", name: "Room 2", sortOrder: 2 },
    { id: "room-01", name: "Room 1", sortOrder: 1 },
  ],
  debates: [
    {
      id: "deb-n-r1",
      divisionCode: "Novice",
      round: 1,
      roomId: "room-02",
      governmentTeamId: "team-n01",
      oppositionTeamId: "team-n02",
      judgeIds: ["judge-02"],
      motion: "This House believes that homework should be abolished.",
    },
    {
      id: "deb-o-r3",
      divisionCode: "Open",
      round: 3,
      roomId: "room-01",
      governmentTeamId: "team-o02",
      oppositionTeamId: "team-o01",
      judgeIds: ["judge-01"],
      motion: "",
    },
    {
      id: "deb-o-r1",
      divisionCode: "Open",
      round: 1,
      roomId: "room-01",
      governmentTeamId: "team-o01",
      oppositionTeamId: "team-o02",
      judgeIds: ["judge-01"],
      motion: "This House would ban single-use plastics on the islands.",
    },
  ],
  revision: 3,
};

export const OPEN_R1_ASSIGNMENT: Assignment = {
  id: "asg_open_r1",
  identity: {
    debateId: "deb-o-r1",
    divisionCode: "Open",
    round: 1,
    judgeId: "judge-01",
    governmentTeamId: "team-o01",
    oppositionTeamId: "team-o02",
    speakers: [
      { id: "spk-o01-1", teamId: "team-o01", side: "government", position: 1 },
      { id: "spk-o01-2", teamId: "team-o01", side: "government", position: 2 },
      { id: "spk-o02-1", teamId: "team-o02", side: "opposition", position: 1 },
      { id: "spk-o02-2", teamId: "team-o02", side: "opposition", position: 2 },
    ],
  },
  display: {
    roomName: "Room 1",
    judgeName: "Marisol Blake",
    roundFormat: "prepared",
    sidesDecided: "in-advance",
    motion: "This House would ban single-use plastics on the islands.",
    government: { teamId: "team-o01", code: "O01", name: "=Compass", school: "Coral Bay Academy" },
    opposition: { teamId: "team-o02", code: "O02", name: "Lantern", school: "Harbourview College" },
    speakers: [
      {
        id: "spk-o01-1",
        name: "Amara Bennett",
        teamId: "team-o01",
        side: "government",
        position: 1,
        role: "pm",
      },
      {
        id: "spk-o01-2",
        name: "Theo Campbell",
        teamId: "team-o01",
        side: "government",
        position: 2,
        role: "gm",
      },
      {
        id: "spk-o02-1",
        name: "Leila Foster",
        teamId: "team-o02",
        side: "opposition",
        position: 1,
        role: "lo",
      },
      {
        id: "spk-o02-2",
        name: "Marcus Grant",
        teamId: "team-o02",
        side: "opposition",
        position: 2,
        role: "om",
      },
    ],
  },
  scheduleRevision: 3,
};

export function receivedRecord(
  overrides: Partial<SheetRecord["sheet"] & object> = {},
): SheetRecord {
  return {
    assignment: OPEN_R1_ASSIGNMENT,
    sheet: {
      payload: {
        scores: {
          "spk-o01-1": {
            argumentation: 27,
            rebuttal: 26,
            presentation: 28,
            poi: 3,
            overall: 84,
            www: "Clear.",
            ebi: "Slower.",
          },
          "spk-o01-2": {
            argumentation: 25,
            rebuttal: 24,
            presentation: 26,
            poi: 2,
            overall: 78,
            www: "Calm.",
            ebi: "Examples.",
          },
          "spk-o02-1": {
            argumentation: 26,
            rebuttal: 27,
            presentation: 27,
            poi: 3,
            overall: 82,
            www: "Sharp.",
            ebi: "Signpost.",
          },
          "spk-o02-2": {
            argumentation: 24,
            rebuttal: 23,
            presentation: 25,
            poi: 1,
            overall: 74,
            www: "Steady.",
            ebi: "Eye contact.",
          },
        },
        sideFlipped: false,
        roleSwaps: {},
      },
      source: "judge",
      receivedAt: "2026-09-16T10:04:00.000Z",
      ...overrides,
    },
  };
}

export const MISSING_RECORD: SheetRecord = { assignment: OPEN_R1_ASSIGNMENT, sheet: null };

export const RESULTS: DivisionResultsLike = {
  divisionCode: "Open",
  debaters: [
    {
      id: "spk-o02-1",
      name: "Leila Foster",
      teamId: "team-o02",
      teamName: "Lantern",
      school: "Harbourview College",
      roundAverages: [82, 80, null],
      total: null,
      average: 81,
      spread: 1.41,
      rank: null,
      status: "unresolved",
    },
    {
      id: "spk-o01-1",
      name: "Amara Bennett",
      teamId: "team-o01",
      teamName: "=Compass",
      school: "Coral Bay Academy",
      roundAverages: [84, 83, 85],
      total: 252,
      average: 84,
      spread: 1,
      rank: 1,
      status: "ready",
    },
    {
      id: "spk-o01-2",
      name: "Theo Campbell",
      teamId: "team-o01",
      teamName: "=Compass",
      school: "Coral Bay Academy",
      roundAverages: [78, 79, 80],
      total: 237,
      average: 79,
      spread: 1,
      rank: 2,
      status: "ready",
    },
  ],
  teams: [
    {
      id: "team-o02",
      code: "O02",
      name: "Lantern",
      school: "Harbourview College",
      total: null,
      rank: null,
      status: "unresolved",
    },
    {
      id: "team-o01",
      code: "O01",
      name: "=Compass",
      school: "Coral Bay Academy",
      total: 489,
      rank: 1,
      status: "ready",
    },
  ],
};

/** One judge's Overall for one debater in one round. */
function source(round: number, seat: number, debaterId: string, value: number): ScoreSource {
  return {
    assignmentId: `asg-r${round}-j${seat}`,
    judgeId: `judge-0${seat}`,
    judgeName: `Judge ${seat}`,
    round,
    debaterId,
    value,
    sheetVersion: 1,
    source: "judge",
  };
}

/**
 * A small division for the real scoring engine: Compass is ready, Lantern's
 * second debater has no round 2 scores yet, and Marlins has one debater.
 */
export function divisionInput(): DivisionInput {
  const marks: Record<string, [number[], number[]]> = {
    "spk-o01-1": [
      [84, 83, 85],
      [82, 84, 83],
    ],
    "spk-o01-2": [
      [78, 79, 80],
      [77, 79, 78],
    ],
    "spk-o02-1": [
      [82, 80, 81],
      [80, 81, 82],
    ],
    "spk-o02-2": [[74, 75, 73], []],
    "spk-o03-1": [
      [70, 71, 72],
      [70, 72, 71],
    ],
  };
  const scores: ScoreSource[] = [];
  for (const [debaterId, rounds] of Object.entries(marks)) {
    rounds.forEach((values, index) => {
      values.forEach((value, seat) => scores.push(source(index + 1, seat + 1, debaterId, value)));
    });
  }
  return {
    divisionId: "Open",
    rounds: [1, 2],
    debaters: [
      { id: "spk-o01-1", name: "Amara Bennett", teamId: "team-o01", position: 1 },
      { id: "spk-o01-2", name: "Theo Campbell", teamId: "team-o01", position: 2 },
      { id: "spk-o02-1", name: "Leila Foster", teamId: "team-o02", position: 1 },
      { id: "spk-o02-2", name: "Marcus Grant", teamId: "team-o02", position: 2 },
      { id: "spk-o03-1", name: "Nadia Hall", teamId: "team-o03", position: 1 },
    ],
    teams: [
      {
        id: "team-o01",
        code: "O01",
        name: "=Compass",
        school: "Coral Bay Academy",
        debaterIds: ["spk-o01-1", "spk-o01-2"],
      },
      {
        id: "team-o02",
        code: "O02",
        name: "Lantern",
        school: "Harbourview College",
        debaterIds: ["spk-o02-1", "spk-o02-2"],
      },
      {
        id: "team-o03",
        code: "O03",
        name: "Marlins",
        school: "Silver Palm High",
        debaterIds: ["spk-o03-1"],
      },
    ],
    expectedSheets: [1, 2].flatMap((round) =>
      [1, 2, 3].map((seat) => ({
        assignmentId: `asg-r${round}-j${seat}`,
        round,
        judgeId: `judge-0${seat}`,
        judgeName: `Judge ${seat}`,
        roomName: "Room 1",
        debaterIds: Object.keys(marks),
        received: true,
      })),
    ),
    scores,
    overrides: [],
    policy: WORKBOOK_POLICY,
    topN: 2,
  };
}
