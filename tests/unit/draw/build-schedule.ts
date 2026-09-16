import { generateDraw, type GenerateDrawInput } from "@/domain/draw";
import type {
  Judge,
  PanelMode,
  Room,
  RoundSetting,
  Schedule,
  Team,
  TournamentSettings,
} from "@/domain/types";

/**
 * Invented schedules for the draw and schedule tests. Every name here is
 * made up: "Open Team 3", "Sample School 2", "Judge 07".
 */

export interface BuildOptions {
  open?: number;
  novice?: number;
  rooms?: number;
  /** Total judges. Defaults to rooms * judgesPerRoom. */
  judges?: number;
  judgesPerRoom?: number;
  panelMode?: PanelMode;
  /** In fixed-room mode, give judges a home room in turn. Default true. */
  allocateJudges?: boolean;
  rounds?: RoundSetting[];
  revision?: number;
}

/** Two prepared rounds with sides in advance, then an impromptu coin-toss round. */
export const THREE_ROUNDS: RoundSetting[] = [
  { number: 1, format: "prepared", sidesDecided: "in-advance" },
  { number: 2, format: "prepared", sidesDecided: "in-advance" },
  { number: 3, format: "impromptu", sidesDecided: "in-room" },
];

export function sampleSettings(overrides: Partial<TournamentSettings> = {}): TournamentSettings {
  return {
    divisions: [
      { code: "Open", name: "Open" },
      { code: "Novice", name: "Novice" },
    ],
    rounds: THREE_ROUNDS,
    rubric: {
      categories: [
        { key: "argumentation", label: "Argumentation", max: 33 },
        { key: "rebuttal", label: "Rebuttal", max: 33 },
        { key: "presentation", label: "Presentation", max: 33 },
        { key: "poi", label: "Points of information", max: 4 },
      ],
      overallMax: 103,
      bands: [{ min: 0, max: 103, label: "Any", summary: "Test band" }],
      noRebuttalScore: 13,
      integersOnly: true,
      commentMaxLength: 500,
    },
    roles: {
      pm: "Prime Minister",
      lo: "Leader of the Opposition",
      gm: "Government Minister",
      om: "Opposition Member",
    },
    timings: { prepared: [5, 5, 5, 5, 2], impromptu: [4, 4, 4, 4, 2] },
    panelMode: "fixed-room",
    judgesPerRoom: 2,
    feedbackRequired: false,
    ...overrides,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function sampleTeam(divisionCode: "Open" | "Novice", n: number): Team {
  const prefix = divisionCode === "Open" ? "O" : "N";
  const code = `${prefix}${pad(n)}`;
  return {
    id: `team-${code}`,
    divisionCode,
    code,
    name: `${divisionCode} Team ${n}`,
    school: `Sample School ${((n - 1) % 7) + 1}`,
    seed: n,
    speakers: [
      { id: `${code}-1`, name: `Debater ${code} One`, position: 1 },
      { id: `${code}-2`, name: `Debater ${code} Two`, position: 2 },
    ],
    status: "active",
  };
}

export function sampleRoom(n: number): Room {
  return { id: `room-${pad(n)}`, name: `Room ${n}`, sortOrder: n };
}

export function sampleJudge(n: number, homeRoomId: string | null = null): Judge {
  return { id: `judge-${pad(n)}`, name: `Judge ${pad(n)}`, homeRoomId, status: "active" };
}

export function buildSchedule(options: BuildOptions = {}): Schedule {
  const open = options.open ?? 20;
  const novice = options.novice ?? 0;
  const roomCount = options.rooms ?? 10;
  const judgesPerRoom = options.judgesPerRoom ?? 2;
  const panelMode = options.panelMode ?? "fixed-room";
  const judgeCount = options.judges ?? roomCount * judgesPerRoom;
  const allocate = (options.allocateJudges ?? true) && panelMode === "fixed-room";

  const rooms = Array.from({ length: roomCount }, (_, i) => sampleRoom(i + 1));
  const judges = Array.from({ length: judgeCount }, (_, i) => {
    const room = rooms[Math.floor(i / judgesPerRoom)];
    return sampleJudge(i + 1, allocate && room ? room.id : null);
  });
  const teams = [
    ...Array.from({ length: open }, (_, i) => sampleTeam("Open", i + 1)),
    ...Array.from({ length: novice }, (_, i) => sampleTeam("Novice", i + 1)),
  ];
  return {
    settings: sampleSettings({ panelMode, judgesPerRoom, rounds: options.rounds ?? THREE_ROUNDS }),
    teams,
    judges,
    rooms,
    debates: [],
    revision: options.revision ?? 1,
  };
}

/** A schedule with a finished draw. Throws in tests when the draw fails. */
export function drawnSchedule(
  options: BuildOptions = {},
  seed = "2026-TEST",
  extra: Partial<GenerateDrawInput> = {},
): Schedule {
  const schedule = buildSchedule(options);
  const divisionCodes = [
    ...((options.open ?? 20) ? ["Open"] : []),
    ...((options.novice ?? 0) ? ["Novice"] : []),
  ];
  const result = generateDraw({ schedule, divisionCodes, seed, method: "random", ...extra });
  if (!result.ok) throw new Error(`draw failed: ${result.error.message}`);
  return { ...schedule, debates: result.debates };
}

/** A deep copy, so a test can edit one schedule without touching another. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
