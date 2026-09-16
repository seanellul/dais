/**
 * Teams and their debaters: list, create, edit, replace a debater, withdraw
 * or delete, and the paste import in the director's spreadsheet shape.
 *
 * A change that alters what a sheet shows (a renamed team) or who it is for
 * (a replaced debater) hands over to `refreshAssignments` in `./draw`, which
 * refreshes kept sheets in place and retires the ones whose matchup changed.
 *
 * Replacing a debater. A team has one row per speaking position (the
 * database enforces it), so a replacement removes the old row and adds a new
 * one with a new id. That is allowed only while no sheet or override refers
 * to the old debater; afterwards the organiser corrects the sheets instead.
 */
import { and, asc, eq } from "drizzle-orm";

import {
  CodeIssuer,
  parseTeamList,
  type ParsedTeam,
  type ParsedTeamList,
} from "@/domain/import/parse-team-list";
import type { SpeakerPosition } from "@/domain/types";
import {
  divisions,
  scoreOverrides,
  speakers,
  teams,
  type SpeakerRow,
  type TeamRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import { isUniqueViolation, type Queryable, type ServiceContext } from "./context";
import { refreshAssignments, type SaveDrawResult } from "./draw";
import { loadGraph, settingsOf, type TournamentGraph } from "./graph";
import { getTournamentById, violatedConstraint } from "./tournaments";

export interface TeamWithSpeakers extends TeamRow {
  /** In position order. */
  speakers: SpeakerRow[];
}

export interface SpeakerInput {
  position: SpeakerPosition;
  name: string;
}

export interface CreateTeamInput {
  divisionCode: string;
  name: string;
  school: string;
  /** Issued from the division's letter when omitted ("O07"). */
  code?: string;
  seed?: number | null;
  /** One or two debaters. */
  speakers: SpeakerInput[];
}

export interface UpdateTeamInput {
  name?: string;
  school?: string;
  code?: string;
  seed?: number | null;
  /** Renames by position. A position the team lacks adds a second debater. */
  speakers?: SpeakerInput[];
  expectedRevision?: number;
}

export interface ReplaceSpeakerOptions {
  allowOrphans?: boolean;
  reason?: string;
  expectedRevision?: number;
}

export interface ImportTeamsInput {
  text: string;
  /** Division for rows without a Division column. */
  divisionCode?: string;
}

export interface ImportCounts {
  teams: number;
  debaters: number;
  byDivision: Record<string, number>;
}

export interface CommitImportResult {
  teams: TeamWithSpeakers[];
  counts: ImportCounts;
}

export type DeleteTeamResult = { status: "withdrawn" } | { status: "deleted" };

// ---------------------------------------------------------------------------
// Reads

/** Every team of the tournament, withdrawn ones included, with debaters in position order. */
export async function listTeams(db: Queryable, tournamentId: string): Promise<TeamWithSpeakers[]> {
  const [teamRows, speakerRows] = await Promise.all([
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
  ]);
  return attachSpeakers(teamRows, speakerRows);
}

function attachSpeakers(teamRows: TeamRow[], speakerRows: SpeakerRow[]): TeamWithSpeakers[] {
  const byTeam = new Map<string, SpeakerRow[]>();
  for (const speaker of speakerRows) {
    byTeam.set(speaker.teamId, [...(byTeam.get(speaker.teamId) ?? []), speaker]);
  }
  return teamRows.map((team) => ({
    ...team,
    speakers: [...(byTeam.get(team.id) ?? [])].sort((a, b) => a.position - b.position),
  }));
}

async function getTeam(
  db: Queryable,
  tournamentId: string,
  teamId: string,
): Promise<TeamWithSpeakers> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.tournamentId, tournamentId), eq(teams.id, teamId)))
    .limit(1);
  if (!team) throw errors.notFound("That team");
  const speakerRows = await db
    .select()
    .from(speakers)
    .where(eq(speakers.teamId, teamId))
    .orderBy(asc(speakers.position));
  return { ...team, speakers: speakerRows };
}

// ---------------------------------------------------------------------------
// Validation helpers

function requireText(value: string | undefined, field: string, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw errors.validation(`Give the team a ${label}.`, {
      issues: [{ path: field, message: `A ${label} is required.` }],
    });
  }
  return trimmed;
}

function requireSpeakers(list: SpeakerInput[]): SpeakerInput[] {
  const cleaned = list.map((speaker) => ({
    position: speaker.position,
    name: speaker.name.trim(),
  }));
  const positions = cleaned.map((speaker) => speaker.position);
  const wellFormed =
    cleaned.length >= 1 &&
    cleaned.length <= 2 &&
    cleaned.every(
      (speaker) => speaker.name.length > 0 && (speaker.position === 1 || speaker.position === 2),
    ) &&
    new Set(positions).size === positions.length;
  if (!wellFormed) {
    throw errors.validation("A team has one or two named debaters, in positions 1 and 2.", {
      issues: [{ path: "speakers", message: "Name each debater once, in position 1 or 2." }],
    });
  }
  return cleaned.sort((a, b) => a.position - b.position);
}

async function requireDivision(db: Queryable, tournamentId: string, code: string): Promise<string> {
  const rows = await db
    .select({ code: divisions.code })
    .from(divisions)
    .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, code)))
    .limit(1);
  if (rows.length === 0) {
    throw errors.validation(`"${code}" is not one of this tournament's divisions.`, {
      issues: [
        { path: "divisionCode", message: "Choose a division from the tournament settings." },
      ],
    });
  }
  return code;
}

/** Turns a unique violation on the teams table into a message the organiser can act on. */
function teamClash(error: unknown, team: { code: string; name: string; school: string }): unknown {
  if (!isUniqueViolation(error)) return error;
  switch (violatedConstraint(error)) {
    case "teams_code_unique":
      return errors.validation(`Team code ${team.code} is already used. Choose another.`, {
        issues: [{ path: "code", message: "This team code is already in use." }],
      });
    case "teams_school_name_unique":
      return errors.validation(
        `${team.school} already has a team called ${team.name} in this division.`,
        { issues: [{ path: "name", message: "This school already has a team with this name." }] },
      );
    default:
      return error;
  }
}

async function existingCodes(db: Queryable, tournamentId: string): Promise<string[]> {
  const rows = await db
    .select({ code: teams.code })
    .from(teams)
    .where(eq(teams.tournamentId, tournamentId));
  return rows.map((row) => row.code);
}

// ---------------------------------------------------------------------------
// Create, update, replace, delete

export async function createTeam(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: CreateTeamInput,
): Promise<TeamWithSpeakers> {
  const divisionCode = await requireDivision(tx, tournamentId, input.divisionCode.trim());
  const name = requireText(input.name, "name", "name");
  const school = requireText(input.school, "school", "school");
  const speakerList = requireSpeakers(input.speakers);
  const code =
    input.code?.trim().toUpperCase() ||
    new CodeIssuer(await existingCodes(tx, tournamentId)).next(divisionCode);
  const now = ctx.now();

  let team: TeamRow;
  try {
    [team] = await tx.transaction((sp) =>
      sp
        .insert(teams)
        .values({
          tournamentId,
          divisionCode,
          code,
          name,
          school,
          seed: input.seed ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
  } catch (error) {
    throw teamClash(error, { code, name, school });
  }
  const speakerRows = await tx
    .insert(speakers)
    .values(
      speakerList.map((speaker) => ({
        tournamentId,
        teamId: team.id,
        position: speaker.position,
        name: speaker.name,
        createdAt: now,
      })),
    )
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.teamsCreated,
    entityType: "team",
    entityId: team.id,
    divisionCode,
    after: { code, name, school, debaters: speakerList.map((speaker) => speaker.name) },
  });
  return { ...team, speakers: speakerRows };
}

/**
 * Edits a team's details and renames its debaters. Names are display-only,
 * so kept sheets are refreshed in place. Adding a missing second debater
 * changes who the sheets are for, so those sheets are retired with a
 * successor by the same refresh.
 */
export async function updateTeam(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  teamId: string,
  patch: UpdateTeamInput,
): Promise<TeamWithSpeakers> {
  const current = await getTeam(tx, tournamentId, teamId);
  const name = patch.name === undefined ? current.name : requireText(patch.name, "name", "name");
  const school =
    patch.school === undefined ? current.school : requireText(patch.school, "school", "school");
  const code =
    patch.code === undefined ? current.code : requireText(patch.code, "code", "code").toUpperCase();
  const seed = patch.seed === undefined ? current.seed : patch.seed;
  const speakerPatch = patch.speakers === undefined ? [] : requireSpeakers(patch.speakers);
  const now = ctx.now();

  const before = teamSummary(current);
  try {
    await tx.transaction((sp) =>
      sp
        .update(teams)
        .set({ name, school, code, seed, updatedAt: now })
        .where(and(eq(teams.tournamentId, tournamentId), eq(teams.id, teamId))),
    );
  } catch (error) {
    throw teamClash(error, { code, name, school });
  }
  for (const speaker of speakerPatch) {
    const existing = current.speakers.find((row) => row.position === speaker.position);
    if (existing) {
      if (existing.name === speaker.name) continue;
      await tx.update(speakers).set({ name: speaker.name }).where(eq(speakers.id, existing.id));
    } else {
      await tx.insert(speakers).values({
        tournamentId,
        teamId,
        position: speaker.position,
        name: speaker.name,
        createdAt: now,
      });
    }
  }
  const updated = await getTeam(tx, tournamentId, teamId);
  const after = teamSummary(updated);
  const diff = diffOf(before, after);
  if (diff.length === 0) return updated;

  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.teamsUpdated,
    entityType: "team",
    entityId: teamId,
    divisionCode: updated.divisionCode,
    diff,
  });
  if (await teamIsDrawn(tx, tournamentId, teamId)) {
    await refreshAssignments(tx, ctx, tournamentId, { expectedRevision: patch.expectedRevision });
  }
  return updated;
}

function teamSummary(team: TeamWithSpeakers) {
  return {
    code: team.code,
    name: team.name,
    school: team.school,
    seed: team.seed,
    debaters: Object.fromEntries(team.speakers.map((speaker) => [speaker.position, speaker.name])),
  };
}

/** True when the team is in any debate of the draw. */
async function teamIsDrawn(db: Queryable, tournamentId: string, teamId: string): Promise<boolean> {
  const graph = await loadGraph(db, tournamentId);
  return graph.debates.some(
    (debate) => debate.governmentTeamId === teamId || debate.oppositionTeamId === teamId,
  );
}

/**
 * Puts a new debater in a speaking position. The old debater's row is
 * removed and a fresh one created, so every sheet for the team's debates is
 * retired with a successor (the matchup changed). Refused once a sheet or an
 * override refers to the old debater.
 */
export async function replaceSpeaker(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  teamId: string,
  position: SpeakerPosition,
  name: string,
  options: ReplaceSpeakerOptions = {},
): Promise<{ team: TeamWithSpeakers; speaker: SpeakerRow; draw: SaveDrawResult | null }> {
  const [cleaned] = requireSpeakers([{ position, name }]);
  const current = await getTeam(tx, tournamentId, teamId);
  const old = current.speakers.find((row) => row.position === position);
  const graph = await loadGraph(tx, tournamentId);
  const now = ctx.now();

  if (old) {
    await refuseIfDebaterScored(tx, graph, old);
    await tx.delete(speakers).where(eq(speakers.id, old.id));
  }
  const [speaker] = await tx
    .insert(speakers)
    .values({ tournamentId, teamId, position, name: cleaned.name, createdAt: now })
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.teamsUpdated,
    entityType: "team",
    entityId: teamId,
    divisionCode: current.divisionCode,
    reason: options.reason ?? null,
    before: old ? { position, debaterId: old.id, name: old.name } : null,
    after: { position, debaterId: speaker.id, name: speaker.name },
  });

  const drawn = graph.debates.some(
    (debate) => debate.governmentTeamId === teamId || debate.oppositionTeamId === teamId,
  );
  const draw = drawn ? await refreshAssignments(tx, ctx, tournamentId, options) : null;
  return { team: await getTeam(tx, tournamentId, teamId), speaker, draw };
}

/** A debater with scores on any sheet, or named by an override, cannot be swapped out. */
async function refuseIfDebaterScored(
  tx: Tx,
  graph: TournamentGraph,
  old: SpeakerRow,
): Promise<void> {
  const scored = graph.sheets.some((sheet) => old.id in sheet.scores);
  const overrides = scored
    ? []
    : await tx
        .select({ id: scoreOverrides.id })
        .from(scoreOverrides)
        .where(
          and(
            eq(scoreOverrides.tournamentId, graph.tournament.id),
            eq(scoreOverrides.speakerId, old.id),
          ),
        )
        .limit(1);
  if (scored || overrides.length > 0) {
    throw errors.validation(
      `${old.name} already has scores on a received sheet, so they can't be replaced. Correct the sheets instead.`,
      { issues: [{ path: "speakers", message: "This debater already has scores." }] },
    );
  }
}

/**
 * Takes a team out of the tournament. A team with scores on a live sheet
 * stays as it is; a team in the draw is marked withdrawn (its debates stay
 * for the organiser to fix); a team in no debate is removed outright.
 */
export async function deleteTeam(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  teamId: string,
  options: { reason?: string } = {},
): Promise<DeleteTeamResult> {
  const team = await getTeam(tx, tournamentId, teamId);
  const graph = await loadGraph(tx, tournamentId);
  const debateIds = new Set(
    graph.debates
      .filter((debate) => debate.governmentTeamId === teamId || debate.oppositionTeamId === teamId)
      .map((debate) => debate.id),
  );
  const sheetIds = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  const scored = graph.assignments.some(
    (assignment) =>
      assignment.live && debateIds.has(assignment.debateId) && sheetIds.has(assignment.id),
  );
  if (scored) {
    throw errors.validation(
      `This team already has scores. Keep ${team.name} (${team.code}) in the tournament and change the draw for the rounds still to come.`,
    );
  }
  const audit = {
    tournamentId,
    action: AUDIT_ACTIONS.teamsDeleted,
    entityType: "team",
    entityId: teamId,
    divisionCode: team.divisionCode,
    reason: options.reason ?? null,
    before: teamSummary(team),
  };
  if (debateIds.size > 0) {
    await tx
      .update(teams)
      .set({ status: "withdrawn", updatedAt: ctx.now() })
      .where(and(eq(teams.tournamentId, tournamentId), eq(teams.id, teamId)));
    await recordAudit(tx, ctx, { ...audit, after: { status: "withdrawn" } });
    return { status: "withdrawn" };
  }
  await tx.delete(speakers).where(eq(speakers.teamId, teamId));
  await tx.delete(teams).where(and(eq(teams.tournamentId, tournamentId), eq(teams.id, teamId)));
  await recordAudit(tx, ctx, { ...audit, after: { status: "deleted" } });
  return { status: "deleted" };
}

// ---------------------------------------------------------------------------
// Paste import

/**
 * Parses a pasted team list against the tournament: division names are
 * matched, codes skip the ones in use, and teams that look like existing
 * ones are flagged. Nothing is written; pass the result to `commitImport`.
 */
export async function importTeams(
  db: Queryable,
  ctx: ServiceContext,
  tournamentId: string,
  input: ImportTeamsInput,
): Promise<ParsedTeamList> {
  const tournament = await getTournamentById(db, tournamentId);
  const settings = settingsOf(tournament);
  const existing = await listTeams(db, tournamentId);
  const parsed = parseTeamList(input.text, {
    divisionCode: input.divisionCode,
    divisions: settings.divisions,
    existingCodes: existing.map((team) => team.code),
    existingTeams: existing.map((team) => ({ school: team.school, name: team.name })),
  });
  ctx.log.info(
    { tournamentId, teams: parsed.teams.length, issues: parsed.issues.length, ok: parsed.ok },
    "Team list parsed",
  );
  return parsed;
}

/** Writes a parsed team list. Refused when the parse had errors or a code is now taken. */
export async function commitImport(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  parsed: Pick<ParsedTeamList, "teams"> & Partial<Pick<ParsedTeamList, "ok" | "issues">>,
): Promise<CommitImportResult> {
  if (parsed.ok === false) {
    throw errors.validation("Fix the problems in the pasted list before importing it.", {
      issues: (parsed.issues ?? [])
        .filter((issue) => issue.level === "error")
        .map((issue) => ({ path: `row.${issue.row}`, message: issue.message })),
    });
  }
  if (parsed.teams.length === 0) {
    throw errors.validation("Nothing to import. Paste one debater per line.");
  }
  const tournament = await getTournamentById(tx, tournamentId);
  const known = new Set(settingsOf(tournament).divisions.map((division) => division.code));
  for (const team of parsed.teams) {
    if (!known.has(team.divisionCode)) {
      throw errors.validation(`"${team.divisionCode}" is not one of this tournament's divisions.`);
    }
    if (team.speakers.length < 1 || team.speakers.length > 2) {
      throw errors.validation(`Team ${team.name} (${team.school}) needs one or two debaters.`);
    }
  }
  const now = ctx.now();
  const inserted = await insertParsedTeams(tx, tournamentId, parsed.teams, now);
  const counts = countImport(parsed.teams);
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.teamsImported,
    entityType: "tournament",
    entityId: null,
    after: counts,
  });
  ctx.log.info({ tournamentId, ...counts }, "Teams imported");
  return { teams: inserted, counts };
}

async function insertParsedTeams(
  tx: Tx,
  tournamentId: string,
  list: readonly ParsedTeam[],
  now: Date,
): Promise<TeamWithSpeakers[]> {
  let teamRows: TeamRow[];
  try {
    teamRows = await tx.transaction((sp) =>
      sp
        .insert(teams)
        .values(
          list.map((team) => ({
            tournamentId,
            divisionCode: team.divisionCode,
            code: team.code,
            name: team.name,
            school: team.school,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .returning(),
    );
  } catch (error) {
    throw importClash(error, list);
  }
  const byCode = new Map(teamRows.map((row) => [row.code, row]));
  const speakerRows = await tx
    .insert(speakers)
    .values(
      list.flatMap((team) =>
        team.speakers.map((speaker) => ({
          tournamentId,
          teamId: (byCode.get(team.code) as TeamRow).id,
          position: speaker.position,
          name: speaker.name,
          createdAt: now,
        })),
      ),
    )
    .returning();
  return attachSpeakers(teamRows, speakerRows).filter((team) => byCode.has(team.code));
}

/** A clash during a batch insert names the list, since the row is not known. */
function importClash(error: unknown, list: readonly ParsedTeam[]): unknown {
  if (!isUniqueViolation(error)) return error;
  const codes = list.map((team) => team.code).join(", ");
  switch (violatedConstraint(error)) {
    case "teams_code_unique":
      return errors.validation(
        `One of the team codes (${codes}) is already in use. Run the preview again to issue fresh codes.`,
      );
    case "teams_school_name_unique":
      return errors.validation(
        "One of the pasted teams is already in the tournament (same school and team name in the same division).",
      );
    default:
      return error;
  }
}

function countImport(list: readonly ParsedTeam[]): ImportCounts {
  const byDivision: Record<string, number> = {};
  let debaters = 0;
  for (const team of list) {
    byDivision[team.divisionCode] = (byDivision[team.divisionCode] ?? 0) + 1;
    debaters += team.speakers.length;
  }
  return { teams: list.length, debaters, byDivision };
}
