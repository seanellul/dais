/**
 * The tournament graph: every row of one tournament, loaded in one go, and
 * the two projections the pure domain understands.
 *
 * - `loadGraph` reads the tables with plain selects in a stable order, so a
 *   snapshot of the same tournament is byte-for-byte repeatable.
 * - `toSchedule` gives `src/domain/schedule` and `src/domain/draw` what they
 *   need: settings, teams with debaters, judges, rooms and debates.
 * - `toDivisionInput` gives `computeDivisionResults` one division: debaters,
 *   teams, the sheets the draw expects, the scores that arrived, and the
 *   organiser's overrides and waivers.
 *
 * Reads take no locks. A service that writes loads the graph inside its
 * transaction so the projection matches what it is about to change.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type {
  DebaterInput,
  DivisionInput,
  ExpectedSheet,
  LoppingPolicy,
  Override,
  ScoreOrigin,
  ScoreSource,
  TeamInput,
} from "@/domain/scoring";
import { parseSettings } from "@/domain/settings";
import type {
  Debate,
  DivisionCode,
  Judge,
  Room,
  Schedule,
  Speaker,
  SpeakerPosition,
  Team,
  TournamentSettings,
} from "@/domain/types";
import {
  assignments,
  auditLog,
  conflicts,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  judgeDevices,
  judges,
  rooms,
  rounds,
  scoreOverrides,
  sheetVersions,
  sheetWaivers,
  sheets,
  speakers,
  teams,
  tournaments,
  type AssignmentRow,
  type ConflictRow,
  type DebateJudgeRow,
  type DebateRow,
  type DebateTeamRow,
  type DivisionRow,
  type JudgeDeviceRow,
  type JudgeRow,
  type RoomRow,
  type RoundRow,
  type ScoreOverrideRow,
  type SheetRow,
  type SheetVersionRow,
  type SheetWaiverRow,
  type SpeakerRow,
  type TeamRow,
  type TournamentRow,
} from "@/server/db";
import { errors } from "@/server/errors";

import type { Queryable } from "./context";

/** An assignment row plus `live`: true until the draw retires it. */
export type GraphAssignment = AssignmentRow & { live: boolean };

/** A sheet's current-version pointer with the current version's content joined in. */
export type GraphSheet = { orphanResolved?: boolean } & SheetRow &
  Pick<
    SheetVersionRow,
    | "scores"
    | "sideFlipped"
    | "roleSwaps"
    | "source"
    | "receivedAt"
    | "actorType"
    | "actorId"
    | "actorName"
    | "reason"
    | "requestKey"
  >;

/** What `loadGraph` includes beyond the live state. All default to false. */
export interface LoadGraphOptions {
  /** Also return resolved and superseded conflicts. */
  includeResolved?: boolean;
  /** Also return revoked overrides and waivers. */
  includeRevoked?: boolean;
  /** Also return every sheet version (`sheetVersions`), not only the current ones. */
  includeVersions?: boolean;
}

/** Every row of one tournament. Rows are the `$inferSelect` types of the schema. */
export interface TournamentGraph {
  tournament: TournamentRow;
  divisions: DivisionRow[];
  rooms: RoomRow[];
  rounds: RoundRow[];
  teams: TeamRow[];
  speakers: SpeakerRow[];
  judges: JudgeRow[];
  debates: DebateRow[];
  debateTeams: DebateTeamRow[];
  debateJudges: DebateJudgeRow[];
  /** Live and retired; check `live`. */
  assignments: GraphAssignment[];
  /** One per assignment that has received a sheet, with the current version joined. */
  sheets: GraphSheet[];
  /** Present only with `includeVersions`. Every version of every sheet, oldest first. */
  sheetVersions?: SheetVersionRow[];
  /** Open conflicts; every conflict with `includeResolved`. */
  conflicts: ConflictRow[];
  /** Live waivers; every waiver with `includeRevoked`. */
  sheetWaivers: SheetWaiverRow[];
  /** Live overrides; every override with `includeRevoked`. */
  scoreOverrides: ScoreOverrideRow[];
  judgeDevices: JudgeDeviceRow[];
  /** The options this graph was loaded with, so a consumer knows what it holds. */
  loaded: Required<LoadGraphOptions>;
}

/**
 * Loads the whole tournament. Throws `errors.notFound` when there is no such
 * tournament. Rows come back in a fixed order (see each query) so the same
 * state always produces the same graph.
 */
export async function loadGraph(
  db: Queryable,
  tournamentId: string,
  options: LoadGraphOptions = {},
): Promise<TournamentGraph> {
  const loaded: Required<LoadGraphOptions> = {
    includeResolved: options.includeResolved ?? false,
    includeRevoked: options.includeRevoked ?? false,
    includeVersions: options.includeVersions ?? false,
  };
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  if (!tournament) throw errors.notFound("That tournament");

  const [setup, schedule, sheetData, governance] = await Promise.all([
    loadSetup(db, tournamentId),
    loadSchedule(db, tournamentId),
    loadSheets(db, tournamentId, loaded),
    loadGovernance(db, tournamentId, loaded),
  ]);
  return { tournament, ...setup, ...schedule, ...sheetData, ...governance, loaded };
}

async function loadSetup(db: Queryable, tournamentId: string) {
  const [divisionRows, roomRows, roundRows, teamRows, speakerRows, judgeRows] = await Promise.all([
    db
      .select()
      .from(divisions)
      .where(eq(divisions.tournamentId, tournamentId))
      .orderBy(asc(divisions.sortOrder), asc(divisions.code)),
    db
      .select()
      .from(rooms)
      .where(eq(rooms.tournamentId, tournamentId))
      .orderBy(asc(rooms.sortOrder), asc(rooms.name), asc(rooms.id)),
    db
      .select()
      .from(rounds)
      .where(eq(rounds.tournamentId, tournamentId))
      .orderBy(asc(rounds.number)),
    db
      .select()
      .from(teams)
      .where(eq(teams.tournamentId, tournamentId))
      .orderBy(asc(teams.divisionCode), asc(teams.code), asc(teams.id)),
    db
      .select()
      .from(speakers)
      .where(eq(speakers.tournamentId, tournamentId))
      .orderBy(asc(speakers.teamId), asc(speakers.position)),
    db
      .select()
      .from(judges)
      .where(eq(judges.tournamentId, tournamentId))
      .orderBy(asc(judges.code), asc(judges.id)),
  ]);
  return {
    divisions: divisionRows,
    rooms: roomRows,
    rounds: roundRows,
    teams: teamRows,
    speakers: speakerRows,
    judges: judgeRows,
  };
}

async function loadSchedule(db: Queryable, tournamentId: string) {
  const [debateRows, debateTeamRows, debateJudgeRows, assignmentRows] = await Promise.all([
    db
      .select()
      .from(debates)
      .where(eq(debates.tournamentId, tournamentId))
      .orderBy(asc(debates.round), asc(debates.divisionCode), asc(debates.roomId), asc(debates.id)),
    db
      .select()
      .from(debateTeams)
      .where(eq(debateTeams.tournamentId, tournamentId))
      .orderBy(asc(debateTeams.debateId), asc(debateTeams.side)),
    db
      .select()
      .from(debateJudges)
      .where(eq(debateJudges.tournamentId, tournamentId))
      .orderBy(asc(debateJudges.debateId), asc(debateJudges.seat)),
    db
      .select()
      .from(assignments)
      .where(eq(assignments.tournamentId, tournamentId))
      .orderBy(asc(assignments.createdAt), asc(assignments.id)),
  ]);
  return {
    debates: debateRows,
    debateTeams: debateTeamRows,
    debateJudges: debateJudgeRows,
    assignments: assignmentRows.map((row) => ({ ...row, live: row.retiredAt === null })),
  };
}

async function loadSheets(db: Queryable, tournamentId: string, loaded: Required<LoadGraphOptions>) {
  const joined = await db
    .select({ sheet: sheets, version: sheetVersions })
    .from(sheets)
    .innerJoin(sheetVersions, eq(sheets.currentVersionId, sheetVersions.id))
    .where(eq(sheets.tournamentId, tournamentId))
    .orderBy(asc(sheets.assignmentId));
  const sheetRows: GraphSheet[] = joined.map(({ sheet, version }) => ({
    ...sheet,
    scores: version.scores,
    sideFlipped: version.sideFlipped,
    roleSwaps: version.roleSwaps,
    source: version.source,
    receivedAt: version.receivedAt,
    actorType: version.actorType,
    actorId: version.actorId,
    actorName: version.actorName,
    reason: version.reason,
    requestKey: version.requestKey,
  }));
  const decisions = await db
    .select({ assignmentId: auditLog.assignmentId, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tournamentId, tournamentId),
        inArray(auditLog.action, ["sheet.orphan_attached", "sheet.orphan_discarded"]),
      ),
    );
  for (const sheet of sheetRows)
    sheet.orphanResolved = decisions.some(
      (d) =>
        d.assignmentId === sheet.assignmentId &&
        d.after !== null &&
        typeof d.after === "object" &&
        "version" in d.after &&
        d.after.version === sheet.version,
    );
  if (!loaded.includeVersions) return { sheets: sheetRows };
  const versionRows = await db
    .select()
    .from(sheetVersions)
    .where(eq(sheetVersions.tournamentId, tournamentId))
    .orderBy(asc(sheetVersions.assignmentId), asc(sheetVersions.version));
  return { sheets: sheetRows, sheetVersions: versionRows };
}

async function loadGovernance(
  db: Queryable,
  tournamentId: string,
  loaded: Required<LoadGraphOptions>,
) {
  const [conflictRows, waiverRows, overrideRows, deviceRows] = await Promise.all([
    db
      .select()
      .from(conflicts)
      .where(
        loaded.includeResolved
          ? eq(conflicts.tournamentId, tournamentId)
          : and(eq(conflicts.tournamentId, tournamentId), eq(conflicts.status, "open")),
      )
      .orderBy(asc(conflicts.createdAt), asc(conflicts.id)),
    db
      .select()
      .from(sheetWaivers)
      .where(
        loaded.includeRevoked
          ? eq(sheetWaivers.tournamentId, tournamentId)
          : and(eq(sheetWaivers.tournamentId, tournamentId), isNull(sheetWaivers.revokedAt)),
      )
      .orderBy(asc(sheetWaivers.createdAt), asc(sheetWaivers.id)),
    db
      .select()
      .from(scoreOverrides)
      .where(
        loaded.includeRevoked
          ? eq(scoreOverrides.tournamentId, tournamentId)
          : and(eq(scoreOverrides.tournamentId, tournamentId), isNull(scoreOverrides.revokedAt)),
      )
      .orderBy(asc(scoreOverrides.createdAt), asc(scoreOverrides.id)),
    db
      .select()
      .from(judgeDevices)
      .where(eq(judgeDevices.tournamentId, tournamentId))
      .orderBy(asc(judgeDevices.judgeId), asc(judgeDevices.deviceId)),
  ]);
  return {
    conflicts: conflictRows,
    sheetWaivers: waiverRows,
    scoreOverrides: overrideRows,
    judgeDevices: deviceRows,
  };
}

// ---------------------------------------------------------------------------
// Projections

/**
 * The tournament's settings, parsed from jsonb. A row that fails the schema
 * is corrupt data, not user input, so it is an internal error with the
 * offending paths in the message (and therefore in the log).
 */
export function settingsOf(tournament: Pick<TournamentRow, "id" | "settings">): TournamentSettings {
  const parsed = parseSettings(tournament.settings);
  if (parsed.ok) return parsed.data;
  const detail = parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw errors.internal(new Error(`Tournament ${tournament.id} has invalid settings: ${detail}`));
}

/**
 * The schedule the draw and validation modules work on: every team (with
 * debaters in position order), every judge, rooms in display order, and
 * debates with their panel in seat order. Withdrawn teams and judges are
 * included with their status, as the domain expects.
 */
export function toSchedule(graph: TournamentGraph): Schedule {
  const settings = settingsOf(graph.tournament);
  const speakersByTeam = groupSpeakers(graph.speakers);
  const judgeIdsByDebate = groupPanels(graph.debateJudges);

  const teamList: Team[] = graph.teams.map((row) => ({
    id: row.id,
    divisionCode: row.divisionCode,
    code: row.code,
    name: row.name,
    school: row.school,
    seed: row.seed,
    speakers: speakersByTeam.get(row.id) ?? [],
    status: row.status,
  }));
  const judgeList: Judge[] = graph.judges.map((row) => ({
    id: row.id,
    name: row.name,
    homeRoomId: row.homeRoomId,
    status: row.status,
  }));
  const roomList: Room[] = graph.rooms.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
  }));
  const debateList: Debate[] = graph.debates.map((row) => ({
    id: row.id,
    divisionCode: row.divisionCode,
    round: row.round,
    roomId: row.roomId,
    governmentTeamId: row.governmentTeamId,
    oppositionTeamId: row.oppositionTeamId,
    judgeIds: judgeIdsByDebate.get(row.id) ?? [],
    motion: row.motion,
  }));
  return {
    settings,
    teams: teamList,
    judges: judgeList,
    rooms: roomList,
    debates: debateList,
    revision: graph.tournament.revision,
  };
}

/** How many teams go through to the final. The Open final is between two teams. */
export const DEFAULT_TOP_N = 2;

/**
 * One division as `computeDivisionResults` wants it.
 *
 * - `divisionId` is the division code, which is how the domain names divisions.
 * - Debaters and teams come from the division's active teams.
 * - `expectedSheets` are the live assignments on the division's debates; a
 *   retired assignment that still holds a sheet is listed as `orphaned` so
 *   the results page can point at it, and its scores are left out.
 * - `scores` are each debater's Overall from the current version of every
 *   live sheet.
 * - `overrides` are the live score overrides for the division plus the live
 *   waivers on its sheets (as `waive_missing_sheet`).
 *
 * Throws `errors.notFound` when the tournament has no such division.
 */
export function toDivisionInput(
  graph: TournamentGraph,
  divisionCode: DivisionCode,
  policy: LoppingPolicy,
): DivisionInput {
  if (!graph.divisions.some((division) => division.code === divisionCode)) {
    throw errors.notFound("That division");
  }
  const settings = settingsOf(graph.tournament);
  const roundNumbers = settings.rounds.map((round) => round.number).sort((a, b) => a - b);
  const speakersByTeam = groupSpeakers(graph.speakers);
  const activeTeams = graph.teams.filter(
    (team) => team.divisionCode === divisionCode && team.status === "active",
  );

  const debaters: DebaterInput[] = activeTeams.flatMap((team) =>
    (speakersByTeam.get(team.id) ?? []).map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      teamId: team.id,
      position: speaker.position,
    })),
  );
  const teamInputs: TeamInput[] = activeTeams.map((team) => ({
    id: team.id,
    code: team.code,
    name: team.name,
    school: team.school,
    debaterIds: (speakersByTeam.get(team.id) ?? []).map((speaker) => speaker.id),
  }));

  const inDivision = assignmentsOfDivision(graph, divisionCode);
  const sheetsByAssignment = new Map(graph.sheets.map((sheet) => [sheet.assignmentId, sheet]));
  const expectedSheets: ExpectedSheet[] = inDivision
    .filter(
      (assignment) =>
        assignment.live ||
        (sheetsByAssignment.has(assignment.id) &&
          !sheetsByAssignment.get(assignment.id)?.orphanResolved),
    )
    .map((assignment) => ({
      assignmentId: assignment.id,
      round: assignment.identity.round,
      judgeId: assignment.judgeId,
      judgeName: assignment.display.judgeName,
      roomName: assignment.display.roomName,
      debaterIds: assignment.identity.speakers.map((speaker) => speaker.id),
      received: sheetsByAssignment.has(assignment.id),
      ...(assignment.live ? {} : { orphaned: true }),
    }));

  const scores: ScoreSource[] = [];
  for (const assignment of inDivision) {
    const sheet = sheetsByAssignment.get(assignment.id);
    if (!assignment.live || !sheet) continue;
    scores.push(...scoresOf(assignment, sheet));
  }

  const assignmentIds = new Set(inDivision.map((assignment) => assignment.id));
  const overrides: Override[] = [
    ...graph.scoreOverrides
      .filter((row) => row.divisionCode === divisionCode && row.revokedAt === null)
      .map(toOverride),
    ...graph.sheetWaivers
      .filter((row) => row.revokedAt === null && assignmentIds.has(row.assignmentId))
      .map((row): Override => ({
        id: row.id,
        kind: "waive_missing_sheet",
        assignmentId: row.assignmentId,
        reason: row.reason,
      })),
  ];

  return {
    divisionId: divisionCode,
    rounds: roundNumbers,
    debaters,
    teams: teamInputs,
    expectedSheets,
    scores,
    overrides,
    policy,
    topN: DEFAULT_TOP_N,
  };
}

/** Debaters per team, in position order, as the domain `Speaker` type. */
function groupSpeakers(rows: readonly SpeakerRow[]): Map<string, Speaker[]> {
  const byTeam = new Map<string, Speaker[]>();
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  for (const row of sorted) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push({ id: row.id, name: row.name, position: positionOf(row.position) });
    byTeam.set(row.teamId, list);
  }
  return byTeam;
}

/** Judge ids per debate in seat order. */
function groupPanels(rows: readonly DebateJudgeRow[]): Map<string, string[]> {
  const byDebate = new Map<string, string[]>();
  const sorted = [...rows].sort((a, b) => a.seat - b.seat);
  for (const row of sorted) {
    const list = byDebate.get(row.debateId) ?? [];
    list.push(row.judgeId);
    byDebate.set(row.debateId, list);
  }
  return byDebate;
}

/** The database allows only 1 and 2 (`speakers_position_1_or_2`); this narrows the type. */
function positionOf(value: number): SpeakerPosition {
  return value === 1 ? 1 : 2;
}

/**
 * The assignments on this division's debates. The debate row is the source
 * of truth (its code follows a division rename); the identity is the
 * fallback for an assignment whose debate is somehow missing.
 */
function assignmentsOfDivision(graph: TournamentGraph, divisionCode: DivisionCode) {
  const divisionOfDebate = new Map(graph.debates.map((debate) => [debate.id, debate.divisionCode]));
  return graph.assignments.filter(
    (assignment) =>
      (divisionOfDebate.get(assignment.debateId) ?? assignment.identity.divisionCode) ===
      divisionCode,
  );
}

/** One `ScoreSource` per debater on the sheet who has a finite Overall score. */
function scoresOf(assignment: GraphAssignment, sheet: GraphSheet): ScoreSource[] {
  const sources: ScoreSource[] = [];
  for (const speaker of assignment.identity.speakers) {
    const overall = sheet.scores[speaker.id]?.overall;
    if (typeof overall !== "number" || !Number.isFinite(overall)) continue;
    sources.push({
      assignmentId: assignment.id,
      judgeId: assignment.judgeId,
      judgeName: assignment.display.judgeName,
      round: assignment.identity.round,
      debaterId: speaker.id,
      value: overall,
      sheetVersion: sheet.version,
      source: scoreOriginOf(sheet.source),
    });
  }
  return sources;
}

/** The `sheet_source` enum as the scoring engine's `ScoreOrigin`. */
export function scoreOriginOf(source: SheetVersionRow["source"]): ScoreOrigin {
  switch (source) {
    case "judge":
      return "judge";
    case "judge_handoff":
      return "judge_handoff";
    case "organiser_paper":
    case "organiser_correction":
      return "organiser_manual";
    case "organiser_resolution":
      return "organiser_resolution";
    case "simulated":
      return "simulation";
    case "import":
      return "import";
  }
}

/** A `score_overrides` row as the scoring engine's `Override`; null columns become absent fields. */
function toOverride(row: ScoreOverrideRow): Override {
  return {
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    ...(row.speakerId === null ? {} : { debaterId: row.speakerId }),
    ...(row.teamId === null ? {} : { teamId: row.teamId }),
    ...(row.round === null ? {} : { round: row.round }),
    ...(row.assignmentId === null ? {} : { assignmentId: row.assignmentId }),
  };
}
