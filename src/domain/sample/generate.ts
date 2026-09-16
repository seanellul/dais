/**
 * Generate a fictional tournament roster from a seed: teams with codes and
 * debaters, judges with home rooms, and rooms. The same seed always gives
 * the same roster, so a demo can be reset in place.
 *
 * Team codes come from the same `CodeIssuer` the team-list import uses, so
 * two divisions that start with the same letter ("Senior", "Sophomore")
 * still get distinct codes and ids.
 *
 * Judges per room defaults to the tournament default (three). With fewer,
 * a simulated rogue score is almost never set aside; see `simulate.ts`.
 */
import type { Judge, Room, Team } from "@/domain/types";
import { CodeIssuer } from "@/domain/import/parse-team-list";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { createRng, type Rng } from "@/domain/sample/prng";
import {
  roomName,
  SAMPLE_FAMILY_NAMES,
  SAMPLE_GIVEN_NAMES,
  SAMPLE_SCHOOLS,
} from "@/domain/sample/names";

export interface GenerateSampleOptions {
  seed: string | number;
  /** Teams in the Open division. */
  open?: number;
  /** Teams in the Novice division. */
  novice?: number;
  rooms?: number;
  /** Defaults to DEFAULT_SETTINGS.judgesPerRoom. */
  judgesPerRoom?: number;
  openCode?: string;
  noviceCode?: string;
}

export interface SampleRoster {
  seed: string;
  teams: Team[];
  judges: Judge[];
  rooms: Room[];
}

export function generateSample(options: GenerateSampleOptions): SampleRoster {
  const {
    seed,
    open = 12,
    novice = 8,
    rooms = 10,
    judgesPerRoom = DEFAULT_SETTINGS.judgesPerRoom,
    openCode = "Open",
    noviceCode = "Novice",
  } = options;
  const rng = createRng(`sample|${seed}`);
  const names = new NamePool(rng);
  const schools = rng.shuffle(SAMPLE_SCHOOLS);
  const teamsPerSchool = new Map<string, number>();
  const codes = new CodeIssuer([]);

  const teams = [
    ...makeTeams(openCode, open, schools, names, teamsPerSchool, codes),
    ...makeTeams(noviceCode, novice, schools, names, teamsPerSchool, codes),
  ];
  const roomList = makeRooms(rooms);
  const judges = makeJudges(roomList, judgesPerRoom, names);
  return { seed: String(seed), teams, judges, rooms: roomList };
}

/** Hands out unique full names so no two people share one. */
class NamePool {
  private readonly used = new Set<string>();

  constructor(private readonly rng: Rng) {}

  next(): string {
    // The pools give thousands of combinations; a clash is rare and resolved
    // by drawing again. The loop is bounded so a tiny pool cannot spin.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const name = `${this.rng.pick(SAMPLE_GIVEN_NAMES)} ${this.rng.pick(SAMPLE_FAMILY_NAMES)}`;
      if (!this.used.has(name)) {
        this.used.add(name);
        return name;
      }
    }
    const fallback = `Debater ${this.used.size + 1}`;
    this.used.add(fallback);
    return fallback;
  }
}

function makeTeams(
  divisionCode: string,
  count: number,
  schools: readonly [string, string][],
  names: NamePool,
  teamsPerSchool: Map<string, number>,
  codes: CodeIssuer,
): Team[] {
  const teams: Team[] = [];
  for (let i = 0; i < count; i += 1) {
    const [school, nickname] = schools[i % schools.length];
    const code = codes.next(divisionCode);
    const id = `team-${code.toLowerCase()}`;
    const ordinal = (teamsPerSchool.get(school) ?? 0) + 1;
    teamsPerSchool.set(school, ordinal);
    teams.push({
      id,
      divisionCode,
      code,
      name: teamName(nickname, ordinal),
      school,
      seed: null,
      speakers: [1, 2].map((position) => ({
        id: `spk-${code.toLowerCase()}-${position}`,
        name: names.next(),
        position: position as 1 | 2,
      })),
      status: "active",
    });
  }
  return teams;
}

/** The first team from a school keeps the nickname; later ones get A, B, C. */
function teamName(nickname: string, ordinal: number): string {
  if (ordinal === 1) return nickname;
  return `${nickname} ${String.fromCharCode(64 + ordinal)}`;
}

function makeRooms(count: number): Room[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `room-${String(i + 1).padStart(2, "0")}`,
    name: roomName(i + 1),
    sortOrder: i + 1,
  }));
}

function makeJudges(rooms: Room[], perRoom: number, names: NamePool): Judge[] {
  const judges: Judge[] = [];
  for (const room of rooms) {
    for (let seat = 0; seat < perRoom; seat += 1) {
      const index = judges.length + 1;
      judges.push({
        id: `judge-${String(index).padStart(2, "0")}`,
        name: names.next(),
        homeRoomId: room.id,
        status: "active",
      });
    }
  }
  return judges;
}
