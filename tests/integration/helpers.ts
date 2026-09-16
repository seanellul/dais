/**
 * Shared seeding for the integration suite.
 *
 * `seedTournament` builds the smallest complete tournament: an organisation,
 * an owner, the tournament with the default settings and workbook policy,
 * and its divisions and rounds. `seedSample` fills it with an invented roster
 * from `generateSample` (no draw). `testContext` gives a `ServiceContext`
 * with a system actor and a fixed request id.
 *
 * Every seed uses unique slugs and codes, so a file also runs against a
 * shared Postgres (`DATABASE_URL_TEST`).
 */
import { randomUUID } from "node:crypto";

import { generateSample, type SampleRoster } from "@/domain/sample";
import { WORKBOOK_POLICY } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { TournamentSettings } from "@/domain/types";
import {
  divisions,
  judges,
  memberships,
  organisations,
  rooms,
  rounds,
  speakers,
  teams,
  tournaments,
  users,
  type Db,
  type JudgeRow,
  type RoomRow,
  type SpeakerRow,
  type TeamRow,
  type TournamentRow,
} from "@/server/db";
import { logger } from "@/server/log";
import { createContext, type ServiceContext } from "@/server/services/context";
import { hashToken, joinCode, randomToken } from "@/server/services/ids";

export interface SeedTournamentOptions {
  name?: string;
  kind?: TournamentRow["kind"];
  /** Defaults to `DEFAULT_SETTINGS`; divisions and rounds are created from it. */
  settings?: TournamentSettings;
}

export interface SeededTournament {
  organisationId: string;
  userId: string;
  tournamentId: string;
  slug: string;
  joinCode: string;
  settings: TournamentSettings;
  divisionCodes: string[];
  roundNumbers: number[];
}

/** Organisation + owner + membership + tournament + divisions + rounds. */
export async function seedTournament(
  db: Db,
  options: SeedTournamentOptions = {},
): Promise<SeededTournament> {
  const suffix = randomUUID().slice(0, 8);
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const code = joinCode();

  const [organisation] = await db
    .insert(organisations)
    .values({ slug: `sample-org-${suffix}`, name: "Sample Debating Society" })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ email: `organiser-${suffix}@example.test`, name: "Sample Organiser" })
    .returning();
  await db
    .insert(memberships)
    .values({ organisationId: organisation.id, userId: user.id, role: "owner" });

  const [tournament] = await db
    .insert(tournaments)
    .values({
      organisationId: organisation.id,
      slug: `sample-${suffix}`,
      name: options.name ?? "Sample Schools Tournament",
      kind: options.kind ?? "sandbox",
      settings,
      scoringPolicy: { ...WORKBOOK_POLICY },
      joinCode: code,
    })
    .returning();

  await db.insert(divisions).values(
    settings.divisions.map((division, index) => ({
      tournamentId: tournament.id,
      code: division.code,
      name: division.name,
      sortOrder: index + 1,
    })),
  );
  await db.insert(rounds).values(
    settings.rounds.map((round) => ({
      tournamentId: tournament.id,
      number: round.number,
      format: round.format,
      sidesDecided: round.sidesDecided,
    })),
  );

  return {
    organisationId: organisation.id,
    userId: user.id,
    tournamentId: tournament.id,
    slug: tournament.slug,
    joinCode: code,
    settings,
    divisionCodes: settings.divisions.map((division) => division.code),
    roundNumbers: settings.rounds.map((round) => round.number),
  };
}

/** A logger that writes nothing, for tests that provoke errors on purpose. */
export const silentLogger = logger.child({ test: true }, { level: "silent" });

/** A `ServiceContext` with a system actor and a fresh `test-` request id. */
export function testContext(db: Db, overrides: Partial<ServiceContext> = {}): ServiceContext {
  const base = createContext({
    db,
    actor: { type: "system", id: "test-runner", name: "Test runner" },
    requestId: `test-${randomUUID().slice(0, 8)}`,
  });
  return { ...base, ...overrides };
}

export interface SeedSampleOptions {
  open?: number;
  novice?: number;
  rooms?: number;
  judgesPerRoom?: number;
  seed?: string;
}

/** Maps from the roster's readable ids ("team-o01") to the uuids the rows were given. */
export interface SampleIdMap {
  rooms: Map<string, string>;
  teams: Map<string, string>;
  speakers: Map<string, string>;
  judges: Map<string, string>;
}

export interface SeededSample {
  roster: SampleRoster;
  rooms: RoomRow[];
  teams: TeamRow[];
  speakers: SpeakerRow[];
  judges: JudgeRow[];
  ids: SampleIdMap;
}

/**
 * Inserts a `generateSample` roster: rooms, teams with their debaters, and
 * judges with home rooms and join tokens. No draw. The division codes must
 * exist on the tournament ("Open" and "Novice" with the default settings).
 */
export async function seedSample(
  db: Db,
  tournamentId: string,
  options: SeedSampleOptions = {},
): Promise<SeededSample> {
  const roster = generateSample({
    seed: options.seed ?? "integration",
    open: options.open,
    novice: options.novice,
    rooms: options.rooms,
    judgesPerRoom: options.judgesPerRoom,
  });
  const ids: SampleIdMap = {
    rooms: new Map(),
    teams: new Map(),
    speakers: new Map(),
    judges: new Map(),
  };

  const roomRows = await db
    .insert(rooms)
    .values(
      roster.rooms.map((room) => ({
        id: mapId(ids.rooms, room.id),
        tournamentId,
        name: room.name,
        sortOrder: room.sortOrder,
      })),
    )
    .returning();

  const teamRows = await db
    .insert(teams)
    .values(
      roster.teams.map((team) => ({
        id: mapId(ids.teams, team.id),
        tournamentId,
        divisionCode: team.divisionCode,
        code: team.code,
        name: team.name,
        school: team.school,
        seed: team.seed ?? null,
        status: team.status,
      })),
    )
    .returning();

  const speakerRows = await db
    .insert(speakers)
    .values(
      roster.teams.flatMap((team) =>
        team.speakers.map((speaker) => ({
          id: mapId(ids.speakers, speaker.id),
          tournamentId,
          teamId: ids.teams.get(team.id) as string,
          position: speaker.position,
          name: speaker.name,
        })),
      ),
    )
    .returning();

  const judgeRows = await db
    .insert(judges)
    .values(
      roster.judges.map((judge, index) => ({
        id: mapId(ids.judges, judge.id),
        tournamentId,
        name: judge.name,
        code: `J${String(index + 1).padStart(2, "0")}`,
        joinTokenHash: hashToken(randomToken()),
        homeRoomId: judge.homeRoomId ? (ids.rooms.get(judge.homeRoomId) ?? null) : null,
        status: judge.status,
      })),
    )
    .returning();

  return {
    roster,
    rooms: roomRows,
    teams: teamRows,
    speakers: speakerRows,
    judges: judgeRows,
    ids,
  };
}

/** Records a fresh uuid for a roster id and returns it. */
function mapId(map: Map<string, string>, rosterId: string): string {
  const id = randomUUID();
  map.set(rosterId, id);
  return id;
}
