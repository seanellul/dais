import type {
  Debate,
  DivisionCode,
  Judge,
  Room,
  RoundSetting,
  Schedule,
  Team,
  TournamentSettings,
} from "../types";
import { compareText } from "./compare";
import { roundPairings, maxRoundsWithoutRepeat } from "./pairings";
import { fixedRoomPanels, perRoundPanels, MAX_PANEL_SIZE, type DrawSlot } from "./panels";
import { createRandom } from "./prng";
import { allocateRoomSlices, preferredRoomOrder, rotateRooms } from "./rooms";
import { normaliseSeed } from "./seed";
import { shuffle } from "./shuffle";
import { orientPairings } from "./sides";

/**
 * The draw: opponents, sides, rooms and panels for one or more divisions.
 *
 * "random" shuffles the team codes with a generator seeded from the seed text
 * and then applies the circle method, which is what the rules describe.
 * "seeded" orders teams by the organiser's seed number instead. Both are
 * deterministic: the same seed and the same team list give the same draw.
 *
 * Reproducibility rules:
 * - Every division gets its own generator, seeded from the seed text plus the
 *   division code. A division's opponents and sides therefore do not depend
 *   on which other divisions are drawn with it, or in what order.
 * - Divisions are drawn in the order of the tournament settings, whatever
 *   order the caller lists them in, so the room split is the same too.
 * - Every sort uses code-unit order (see compare.ts), never the locale.
 */

export type DrawMethod = "random" | "seeded";

export interface GenerateDrawInput {
  schedule: Schedule;
  /** Divisions drawn together. They share the room and judge pools. */
  divisionCodes: DivisionCode[];
  /** Any non-empty text; see seed.ts for the generated shape. */
  seed: string;
  method: DrawMethod;
  /** How many of the tournament's rounds to draw. Defaults to all of them. */
  rounds?: number;
  /** Panel size to aim for. Defaults to settings.judgesPerRoom, clamped to 1–5. */
  judgesPerRoom?: number;
}

export type DrawErrorCode =
  | "seed-missing"
  | "no-divisions"
  | "unknown-division"
  | "no-rounds"
  | "too-few-teams"
  | "odd-team-count"
  | "too-many-rounds"
  | "not-enough-rooms";

export interface DrawError {
  code: DrawErrorCode;
  message: string;
}

export type DrawResult =
  | {
      ok: true;
      /** Debates of other divisions are kept as they were, followed by the new ones. */
      debates: Debate[];
      /** The normalised seed that reproduces this draw. */
      seed: string;
      /** Things the organiser should look at; none of them stop the draw. */
      warnings: string[];
    }
  | { ok: false; error: DrawError };

interface DivisionPlan {
  divisionCode: DivisionCode;
  rounds: ReturnType<typeof orientPairings>;
}

export function generateDraw(input: GenerateDrawInput): DrawResult {
  const { schedule } = input;
  const { settings } = schedule;
  const seed = normaliseSeed(input.seed);
  if (!seed) return failure("seed-missing", "Enter a seed for the draw, or generate one.");

  const requested = [...new Set(input.divisionCodes)];
  if (!requested.length) return failure("no-divisions", "Choose at least one division to draw.");
  const unknown = requested.find((code) => !settings.divisions.some((d) => d.code === code));
  if (unknown !== undefined) {
    return failure("unknown-division", `"${unknown}" is not one of the tournament's divisions.`);
  }
  const divisionCodes = inSettingsOrder(settings, requested);

  const rounds = resolveRounds(settings, input.rounds);
  if (!rounds.length)
    return failure("no-rounds", "Add at least one round in Settings before drawing.");

  const judgesPerRoom = clamp(input.judgesPerRoom ?? settings.judgesPerRoom, 1, MAX_PANEL_SIZE);
  const warnings: string[] = [];

  // 1. Opponents and sides, division by division, each from its own generator.
  const plans: DivisionPlan[] = [];
  for (const divisionCode of divisionCodes) {
    const teams = activeTeams(schedule, divisionCode);
    const problem = checkTeamCount(settings, divisionCode, teams.length, rounds.length);
    if (problem) return { ok: false, error: problem };
    const random = createRandom(divisionSeed(seed, divisionCode));
    const ordered =
      input.method === "random"
        ? shuffle(teams, random)
        : bySeed(teams, warnings, settings, divisionCode);
    const pairs = roundPairings(
      ordered.map((team) => team.id),
      rounds.length,
    );
    plans.push({ divisionCode, rounds: orientPairings(pairs, sidePriority(rounds)) });
  }

  // 2. Rooms: one shared pool, minus rooms used by divisions not being drawn.
  const untouched = schedule.debates.filter(
    (debate) => !divisionCodes.includes(debate.divisionCode),
  );
  const occupiedRooms = new Set(untouched.map((debate) => debate.roomId));
  const judges = schedule.judges.filter((judge) => judge.status === "active");
  const pool = preferredRoomOrder(
    schedule.rooms.filter((room) => !occupiedRooms.has(room.id)),
    judges,
    settings.panelMode,
  );
  const demands = plans.map((plan) => ({
    divisionCode: plan.divisionCode,
    count: plan.rounds[0].length,
  }));
  const slices = allocateRoomSlices(pool, demands);
  if (!slices) return failure("not-enough-rooms", notEnoughRooms(settings, demands, pool.length));

  // 3. One slot per pairing per round, with rooms rotated within each division.
  const slots: DrawSlot[] = [];
  for (const plan of plans) {
    const roomIds = rotateRooms(plan.rounds, slices.get(plan.divisionCode) ?? []);
    plan.rounds.forEach((pairs, roundIndex) => {
      pairs.forEach((pair, index) => {
        slots.push({
          divisionCode: plan.divisionCode,
          round: rounds[roundIndex].number,
          index,
          roomId: roomIds[roundIndex][index],
          ...pair,
          judgeIds: [],
        });
      });
    });
  }
  slots.sort(
    (a, b) =>
      a.round - b.round ||
      divisionCodes.indexOf(a.divisionCode) - divisionCodes.indexOf(b.divisionCode) ||
      a.index - b.index,
  );

  // 4. Panels.
  const roomName = roomNamer(schedule.rooms);
  const panels =
    settings.panelMode === "fixed-room"
      ? fixedRoomPanels({ slots, judges: freeJudges(judges, untouched), judgesPerRoom, roomName })
      : perRoundPanels({
          slots,
          judgesForRound: (round) =>
            freeJudges(
              judges,
              untouched.filter((debate) => debate.round === round),
            ),
          judgesPerRoom,
          roomName,
        });
  warnings.push(...panels.warnings);

  // 5. Debates.
  const debates = panels.slots.map((slot) => toDebate(slot));
  return { ok: true, debates: [...untouched, ...debates], seed, warnings };
}

function failure(code: DrawErrorCode, message: string): DrawResult {
  return { ok: false, error: { code, message } };
}

/** The seed text for one division's generator, e.g. "2026-K7PM:Open". */
export function divisionSeed(seed: string, divisionCode: DivisionCode): string {
  return `${seed}:${divisionCode}`;
}

/** The requested divisions in the order they appear in the tournament settings. */
function inSettingsOrder(
  settings: TournamentSettings,
  codes: readonly DivisionCode[],
): DivisionCode[] {
  return settings.divisions.map((division) => division.code).filter((code) => codes.includes(code));
}

/** The tournament's rounds in number order, cut to the requested count. */
function resolveRounds(
  settings: TournamentSettings,
  requested: number | undefined,
): RoundSetting[] {
  const ordered = [...settings.rounds].sort((a, b) => a.number - b.number);
  if (requested === undefined) return ordered;
  return ordered.slice(0, Math.max(0, Math.floor(requested)));
}

/** Rounds with sides decided in advance are balanced first (see sides.ts). */
function sidePriority(rounds: readonly RoundSetting[]): number[] {
  const indexes = rounds.map((_, index) => index);
  const inAdvance = indexes.filter((index) => rounds[index].sidesDecided === "in-advance");
  const inRoom = indexes.filter((index) => rounds[index].sidesDecided !== "in-advance");
  return [...inAdvance, ...inRoom];
}

function activeTeams(schedule: Schedule, divisionCode: DivisionCode): Team[] {
  return schedule.teams
    .filter((team) => team.divisionCode === divisionCode && team.status === "active")
    .sort((a, b) => compareText(a.code, b.code) || compareText(a.id, b.id));
}

function checkTeamCount(
  settings: TournamentSettings,
  divisionCode: DivisionCode,
  count: number,
  rounds: number,
): DrawError | null {
  const name = divisionName(settings, divisionCode);
  if (count < 4) {
    return {
      code: "too-few-teams",
      message: `${name} has ${countTeams(count)}; a draw needs at least four.`,
    };
  }
  if (count % 2 !== 0) {
    return {
      code: "odd-team-count",
      message: `Add one more team so ${name} has an even number of teams.`,
    };
  }
  if (rounds > maxRoundsWithoutRepeat(count)) {
    return {
      code: "too-many-rounds",
      message: `${name} has ${count} teams, which allows at most ${maxRoundsWithoutRepeat(count)} rounds without a repeat opponent.`,
    };
  }
  return null;
}

/** Seeded order: by seed number, then teams without a seed by code. */
function bySeed(
  teams: readonly Team[],
  warnings: string[],
  settings: TournamentSettings,
  divisionCode: DivisionCode,
): Team[] {
  const unseeded = teams.filter((team) => team.seed === null || team.seed === undefined);
  if (unseeded.length) {
    warnings.push(
      `${countTeams(unseeded.length)} in ${divisionName(settings, divisionCode)} ${unseeded.length === 1 ? "has" : "have"} no seed number and ${unseeded.length === 1 ? "was" : "were"} placed after the seeded teams, by team code.`,
    );
  }
  return [...teams].sort(
    (a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity) || compareText(a.code, b.code),
  );
}

/**
 * Judges not seated by debates outside this draw, in name order. The order
 * decides which reserve judge tops up which room, so it is code-unit order:
 * the same on every host.
 */
function freeJudges(judges: readonly Judge[], busyDebates: readonly Debate[]): Judge[] {
  const busy = new Set(busyDebates.flatMap((debate) => debate.judgeIds));
  return judges
    .filter((judge) => !busy.has(judge.id))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
}

function notEnoughRooms(
  settings: TournamentSettings,
  demands: readonly { divisionCode: DivisionCode; count: number }[],
  available: number,
): string {
  const needed = demands.reduce((sum, demand) => sum + demand.count, 0);
  const breakdown = demands
    .map((demand) => `${demand.count} for ${divisionName(settings, demand.divisionCode)}`)
    .join(" and ");
  return `Each round needs ${needed} rooms at once (${breakdown}); only ${available} ${available === 1 ? "room is" : "rooms are"} free.`;
}

function roomNamer(rooms: readonly Room[]): (roomId: string) => string {
  const names = new Map(rooms.map((room) => [room.id, room.name]));
  return (roomId) => names.get(roomId) ?? roomId;
}

function toDebate(slot: DrawSlot): Debate {
  return {
    id: debateId(slot.divisionCode, slot.round, slot.index),
    divisionCode: slot.divisionCode,
    round: slot.round,
    roomId: slot.roomId,
    governmentTeamId: slot.governmentTeamId,
    oppositionTeamId: slot.oppositionTeamId,
    judgeIds: slot.judgeIds,
    motion: "",
  };
}

/** A readable, deterministic debate id such as "debate-open-r1-d3". */
export function debateId(divisionCode: DivisionCode, round: number, index: number): string {
  const slug = divisionCode
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `debate-${slug || "division"}-r${round}-d${index + 1}`;
}

function divisionName(settings: TournamentSettings, code: DivisionCode): string {
  return settings.divisions.find((division) => division.code === code)?.name ?? code;
}

function countTeams(count: number): string {
  return count === 1 ? "1 team" : `${count} teams`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
