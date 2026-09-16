/**
 * Tournaments: create, look up, rename, archive and "duplicate for next year".
 *
 * A tournament row carries the settings (divisions, rounds, rubric) and the
 * outlier policy as JSON; the `divisions` and `rounds` tables mirror the
 * settings so that other rows can reference them with foreign keys. This
 * module keeps the two in step on creation; `./settings` keeps them in step
 * on every later edit.
 *
 * Membership checks are the guards' job (`src/server/auth/guards.ts`): every
 * function here trusts that the caller may act on the organisation.
 */
import { and, asc, desc, eq } from "drizzle-orm";

import { WORKBOOK_POLICY, type LoppingPolicy } from "@/domain/scoring";
import { DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";
import type { TournamentSettings } from "@/domain/types";
import {
  divisions,
  judges,
  rooms,
  rounds,
  speakers,
  teams,
  tournaments,
  type TournamentRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";
import { joinTokenHashFor } from "@/server/auth/tokens";

import { diffOf, recordAudit } from "./audit";
import { isUniqueViolation, type Queryable, type ServiceContext } from "./context";
import { joinCode, newId } from "./ids";

/**
 * Audit actions for the tournament itself. They follow the `entity.event`
 * shape of `AUDIT_ACTIONS`; the integrate step should move them there.
 */
export const TOURNAMENT_AUDIT_ACTIONS = {
  created: "tournament.created",
  updated: "tournament.updated",
  archived: "tournament.archived",
  duplicated: "tournament.duplicated",
} as const;

/** How many fresh join codes to try before giving up on a run of collisions. */
const JOIN_CODE_ATTEMPTS = 5;

export type TournamentKind = TournamentRow["kind"];

export interface CreateTournamentInput {
  organisationId: string;
  name: string;
  /** Defaults to a slug made from the name. Unique within the organisation. */
  slug?: string;
  kind?: TournamentKind;
  /** Defaults to `DEFAULT_SETTINGS`. Divisions and rounds are created from it. */
  settings?: TournamentSettings;
  /** Defaults to `WORKBOOK_POLICY`. */
  scoringPolicy?: LoppingPolicy;
}

export interface UpdateTournamentInput {
  name?: string;
  slug?: string;
}

export interface DuplicateTournamentInput {
  name: string;
  slug?: string;
  kind?: TournamentKind;
  /** Copy the active teams and their debaters. Rooms, judges and settings are always copied. */
  copyTeams?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers (used by the other setup services)

/**
 * The unique constraint or index a `23505` error names, if any. node-postgres
 * exposes it as `constraint`; PGlite and node-postgres both quote it in the
 * message, which is the fallback.
 */
export function violatedConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const { constraint, message, cause } = current as {
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof constraint === "string" && constraint.length > 0) return constraint;
    if (typeof message === "string") {
      const match = /violates unique constraint "([^"]+)"/.exec(message);
      if (match) return match[1];
    }
    current = cause;
  }
  return undefined;
}

/**
 * Runs `work` in a savepoint and retries it with a fresh attempt when it
 * fails on `constraint`. Postgres aborts a transaction after any failed
 * statement, so a retry without a savepoint would fail with "current
 * transaction is aborted"; the savepoint keeps the caller's work intact.
 */
export async function retryOnUniqueViolation<T>(
  tx: Tx,
  constraint: string,
  attempts: number,
  work: (sp: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await tx.transaction(work);
    } catch (error) {
      const again =
        attempt < attempts && isUniqueViolation(error) && violatedConstraint(error) === constraint;
      if (!again) throw error;
    }
  }
}

/** Reads a tournament row and takes a row lock on it for the rest of the transaction. */
export async function lockTournament(tx: Tx, tournamentId: string): Promise<TournamentRow> {
  const [row] = await tx
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .for("update");
  if (!row) throw errors.notFound("That tournament");
  return row;
}

/** "Conyers Inter-Schools 2027" -> "conyers-inter-schools-2027". Empty when nothing survives. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function requireName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    throw errors.validation("Give the tournament a name.", {
      issues: [{ path: "name", message: "A name is required." }],
    });
  }
  return trimmed;
}

function requireSlug(slug: string | undefined, name: string): string {
  const cleaned = slugify(slug?.trim() || name);
  if (cleaned.length === 0) {
    throw errors.validation("The web address needs at least one letter or number.", {
      issues: [{ path: "slug", message: "A web address is required." }],
    });
  }
  return cleaned;
}

function requireSettings(input: TournamentSettings): TournamentSettings {
  const parsed = parseSettings(input);
  if (parsed.ok) return parsed.data;
  throw errors.validation("Some of the tournament settings are not valid.", {
    issues: parsed.errors,
  });
}

function slugTaken(slug: string) {
  return errors.validation(
    `A tournament with the web address "${slug}" already exists in this organisation. Choose another.`,
    { issues: [{ path: "slug", message: "This web address is already in use." }] },
  );
}

/** Inserts the tournament with a fresh join code, trying again on a clash. */
async function insertTournament(
  tx: Tx,
  values: Omit<typeof tournaments.$inferInsert, "joinCode">,
  slug: string,
): Promise<TournamentRow> {
  try {
    return await retryOnUniqueViolation(
      tx,
      "tournaments_join_code_unique",
      JOIN_CODE_ATTEMPTS,
      async (sp) => {
        const [row] = await sp
          .insert(tournaments)
          .values({ ...values, joinCode: joinCode() })
          .returning();
        return row;
      },
    );
  } catch (error) {
    if (isUniqueViolation(error) && violatedConstraint(error) === "tournaments_slug_unique") {
      throw slugTaken(slug);
    }
    throw error;
  }
}

/** Creates the `divisions` and `rounds` rows that mirror the settings. */
async function insertDivisionsAndRounds(
  tx: Tx,
  tournamentId: string,
  settings: TournamentSettings,
  at: Date,
): Promise<void> {
  await tx.insert(divisions).values(
    settings.divisions.map((division, index) => ({
      tournamentId,
      code: division.code,
      name: division.name,
      sortOrder: index + 1,
      createdAt: at,
    })),
  );
  await tx.insert(rounds).values(
    settings.rounds.map((round) => ({
      tournamentId,
      number: round.number,
      format: round.format,
      sidesDecided: round.sidesDecided,
      createdAt: at,
    })),
  );
}

// ---------------------------------------------------------------------------
// Create, read, update

/**
 * Creates a tournament with its divisions and rounds and a fresh join code.
 * The join code is retried on a collision; a slug clash is a validation error.
 */
export async function createTournament(
  tx: Tx,
  ctx: ServiceContext,
  input: CreateTournamentInput,
): Promise<TournamentRow> {
  const name = requireName(input.name);
  const slug = requireSlug(input.slug, name);
  const settings = requireSettings(input.settings ?? DEFAULT_SETTINGS);
  const policy: LoppingPolicy = { ...(input.scoringPolicy ?? WORKBOOK_POLICY) };
  const now = ctx.now();

  const row = await insertTournament(
    tx,
    {
      organisationId: input.organisationId,
      slug,
      name,
      kind: input.kind ?? "live",
      settings,
      // Spread: the interface has no index signature, the jsonb column type does.
      scoringPolicy: { ...policy },
      createdAt: now,
      updatedAt: now,
    },
    slug,
  );
  await insertDivisionsAndRounds(tx, row.id, settings, now);
  await recordAudit(tx, ctx, {
    tournamentId: row.id,
    action: TOURNAMENT_AUDIT_ACTIONS.created,
    entityType: "tournament",
    entityId: row.id,
    after: { name, slug, kind: row.kind },
  });
  ctx.log.info({ tournamentId: row.id, slug }, "Tournament created");
  return row;
}

/** Every tournament of an organisation, newest first. Archived ones included; filter on `status`. */
export async function listTournaments(
  db: Queryable,
  organisationId: string,
): Promise<TournamentRow[]> {
  return db
    .select()
    .from(tournaments)
    .where(eq(tournaments.organisationId, organisationId))
    .orderBy(desc(tournaments.createdAt), asc(tournaments.slug));
}

export async function getTournamentBySlug(
  db: Queryable,
  organisationId: string,
  slug: string,
): Promise<TournamentRow> {
  const [row] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.organisationId, organisationId), eq(tournaments.slug, slug)))
    .limit(1);
  if (!row) throw errors.notFound("That tournament");
  return row;
}

export async function getTournamentById(db: Queryable, id: string): Promise<TournamentRow> {
  const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
  if (!row) throw errors.notFound("That tournament");
  return row;
}

/** Renames a tournament or changes its web address. Records the change in the history. */
export async function updateTournament(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  patch: UpdateTournamentInput,
): Promise<TournamentRow> {
  const current = await lockTournament(tx, tournamentId);
  const name = patch.name === undefined ? current.name : requireName(patch.name);
  const slug = patch.slug === undefined ? current.slug : requireSlug(patch.slug, name);
  const before = { name: current.name, slug: current.slug };
  const after = { name, slug };
  if (name === current.name && slug === current.slug) return current;

  let row: TournamentRow;
  try {
    [row] = await tx.transaction((sp) =>
      sp
        .update(tournaments)
        .set({ name, slug, updatedAt: ctx.now() })
        .where(eq(tournaments.id, tournamentId))
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error) && violatedConstraint(error) === "tournaments_slug_unique") {
      throw slugTaken(slug);
    }
    throw error;
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: TOURNAMENT_AUDIT_ACTIONS.updated,
    entityType: "tournament",
    entityId: tournamentId,
    diff: diffOf(before, after),
  });
  return row;
}

/** Marks a tournament archived. Nothing is deleted; it leaves the live list. */
export async function archiveTournament(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
): Promise<TournamentRow> {
  const current = await lockTournament(tx, tournamentId);
  if (current.status === "archived") return current;
  const [row] = await tx
    .update(tournaments)
    .set({ status: "archived", updatedAt: ctx.now() })
    .where(eq(tournaments.id, tournamentId))
    .returning();
  await recordAudit(tx, ctx, {
    tournamentId,
    action: TOURNAMENT_AUDIT_ACTIONS.archived,
    entityType: "tournament",
    entityId: tournamentId,
    diff: diffOf({ status: current.status }, { status: "archived" }),
  });
  return row;
}

// ---------------------------------------------------------------------------
// Duplicate for next year

/**
 * Creates a new tournament from an existing one: the same settings and
 * outlier policy, the same rooms, the active judges (new join tokens, the
 * same codes) and, when asked, the active teams with their debaters. The
 * draw, sheets, results and history are never copied.
 */
export async function duplicateForNextYear(
  tx: Tx,
  ctx: ServiceContext,
  sourceTournamentId: string,
  input: DuplicateTournamentInput,
): Promise<TournamentRow> {
  const source = await getTournamentById(tx, sourceTournamentId);
  const settings = requireSettings(source.settings);
  const created = await createTournament(tx, ctx, {
    organisationId: source.organisationId,
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? source.kind,
    settings,
    scoringPolicy: source.scoringPolicy as unknown as LoppingPolicy,
  });
  const now = ctx.now();

  const roomMap = await copyRooms(tx, source.id, created.id, now);
  const judgeCount = await copyJudges(tx, source.id, created.id, roomMap, now);
  const teamCount = input.copyTeams ? await copyTeams(tx, source.id, created.id, now) : 0;

  await recordAudit(tx, ctx, {
    tournamentId: created.id,
    action: TOURNAMENT_AUDIT_ACTIONS.duplicated,
    entityType: "tournament",
    entityId: created.id,
    after: {
      sourceTournamentId: source.id,
      copied: { rooms: roomMap.size, judges: judgeCount, teams: teamCount },
    },
  });
  return created;
}

/** Copies rooms and returns old id -> new id. */
async function copyRooms(
  tx: Tx,
  sourceId: string,
  targetId: string,
  at: Date,
): Promise<Map<string, string>> {
  const sourceRooms = await tx
    .select()
    .from(rooms)
    .where(eq(rooms.tournamentId, sourceId))
    .orderBy(asc(rooms.sortOrder), asc(rooms.name));
  const map = new Map<string, string>();
  if (sourceRooms.length === 0) return map;
  const inserted = await tx
    .insert(rooms)
    .values(
      sourceRooms.map((room) => ({
        tournamentId: targetId,
        name: room.name,
        sortOrder: room.sortOrder,
        createdAt: at,
      })),
    )
    .returning();
  sourceRooms.forEach((room, index) => map.set(room.id, inserted[index].id));
  return map;
}

/** Copies active judges with fresh join tokens. Returns how many were copied. */
async function copyJudges(
  tx: Tx,
  sourceId: string,
  targetId: string,
  roomMap: Map<string, string>,
  at: Date,
): Promise<number> {
  const sourceJudges = await tx
    .select()
    .from(judges)
    .where(and(eq(judges.tournamentId, sourceId), eq(judges.status, "active")))
    .orderBy(asc(judges.code));
  if (sourceJudges.length === 0) return 0;
  // Ids are chosen here because a join token is derived from the judge's id and epoch.
  await tx.insert(judges).values(
    sourceJudges.map((judge) => {
      const id = newId();
      return {
        id,
        tournamentId: targetId,
        name: judge.name,
        code: judge.code,
        joinTokenHash: joinTokenHashFor({ id, sessionEpoch: 0 }),
        homeRoomId: judge.homeRoomId ? (roomMap.get(judge.homeRoomId) ?? null) : null,
        createdAt: at,
        updatedAt: at,
      };
    }),
  );
  return sourceJudges.length;
}

/** Copies active teams and their debaters. Returns how many teams were copied. */
async function copyTeams(tx: Tx, sourceId: string, targetId: string, at: Date): Promise<number> {
  const sourceTeams = await tx
    .select()
    .from(teams)
    .where(and(eq(teams.tournamentId, sourceId), eq(teams.status, "active")))
    .orderBy(asc(teams.divisionCode), asc(teams.code));
  if (sourceTeams.length === 0) return 0;
  const sourceSpeakers = await tx
    .select()
    .from(speakers)
    .where(eq(speakers.tournamentId, sourceId))
    .orderBy(asc(speakers.teamId), asc(speakers.position));

  const inserted = await tx
    .insert(teams)
    .values(
      sourceTeams.map((team) => ({
        tournamentId: targetId,
        divisionCode: team.divisionCode,
        code: team.code,
        name: team.name,
        school: team.school,
        seed: team.seed,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .returning();
  const teamMap = new Map(sourceTeams.map((team, index) => [team.id, inserted[index].id]));
  const speakerRows = sourceSpeakers
    .filter((speaker) => teamMap.has(speaker.teamId))
    .map((speaker) => ({
      tournamentId: targetId,
      teamId: teamMap.get(speaker.teamId) as string,
      position: speaker.position,
      name: speaker.name,
      createdAt: at,
    }));
  if (speakerRows.length) await tx.insert(speakers).values(speakerRows);
  return sourceTeams.length;
}
