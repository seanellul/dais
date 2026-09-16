/**
 * Backup, import and restore of one tournament.
 *
 * - `exportBackup` turns a tournament into one JSON document: every row of
 *   every tournament table in a fixed order, plus a checksum, so an organiser
 *   can keep a copy on a laptop and a self-hoster can move a tournament
 *   between installs.
 * - `importBackup` creates a *new* tournament from a backup. Primary keys
 *   are uuids that are unique across the whole database, so every id is
 *   replaced with a fresh one and every reference follows. Assignment ids
 *   are content hashes over those ids, so they are derived again for the new
 *   tournament and the sheets are re-attached by (debate, judge) slot.
 * - `restoreInPlace` puts a backup back over the *same* tournament: the
 *   children are deleted and the backup's rows are inserted with their
 *   original ids, which are free again once the old rows are gone. A
 *   pre-restore snapshot is stored first and every judge is signed out.
 *
 * The audit log is exported for the record but never imported or restored:
 * it is append-only and outlives the rows it describes. The shared delete
 * and insert helpers at the bottom are also what `sandbox.ts` uses to reset
 * a sandbox from its creation snapshot.
 *
 * Judge secrets: a judge's code is unique per tournament and their join
 * token hash is unique across the whole database. A copy therefore keeps
 * the codes (printed cards still read right) but always gets fresh join
 * tokens; a restore over the same tournament keeps both, falling back to
 * the rows it is replacing when the backup was exported without secrets.
 *
 * `DEMO_LIFETIME_MS` and `CREATION_SNAPSHOT_LABEL` live here rather than in
 * `demo.ts` because an import as a demo or sandbox needs them and `demo.ts`
 * builds on this module; `demo.ts` re-exports them.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import packageJson from "../../../package.json";

import {
  assignmentId as hashAssignmentId,
  canonicalJson,
  deriveAssignments,
  slotKey,
} from "@/domain/schedule";
import { parseSettings } from "@/domain/settings";
import type {
  AssignmentDisplay,
  AssignmentIdentity,
  SheetPayload,
  SheetScores,
} from "@/domain/types";
import {
  assignments,
  auditLog,
  checklistOverrides,
  conflicts,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  judgeDevices,
  judges,
  organisations,
  rooms,
  rounds,
  scoreOverrides,
  sessions,
  setupRevisions,
  sheetVersions,
  sheetWaivers,
  sheets,
  speakers,
  submissions,
  teams,
  tournaments,
  type AssignmentRow,
  type NewTournamentRow,
  type Tx,
  type TournamentRow,
} from "@/server/db";
import { errors, validationFromZod } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import type { Queryable, ServiceContext } from "./context";
import { isUniqueViolation, withTransaction } from "./context";
import { loadGraph, toSchedule, type GraphAssignment, type TournamentGraph } from "./graph";
import { crockfordCode, hashToken, joinCode, newId, randomToken, sha256Hex } from "./ids";
import { snapshotTournament } from "./snapshots";

/** The `format` field of every backup, so an import can refuse a stranger. */
export const BACKUP_FORMAT = "dais-backup";
/** Bump when the document shape changes; an import checks it. */
export const BACKUP_SCHEMA_VERSION = 1;

/** How long a per-visitor demo lives. Expiry is `tournaments.demo_expires_at`. */
export const DEMO_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The label of the snapshot a new sandbox or demo stores and `resetSandbox` restores. */
export const CREATION_SNAPSHOT_LABEL = "Creation";

// ---------------------------------------------------------------------------
// The document shape, as zod schemas. Dates travel as ISO strings.
// ---------------------------------------------------------------------------

const uuid = z.uuid();
const isoDate = z
  .string()
  .refine((text) => !Number.isNaN(Date.parse(text)), { error: "Expected an ISO 8601 date." });
const nullableDate = isoDate.nullable();
const nullableText = z.string().nullable();
const jsonRecord = z.record(z.string(), z.unknown());
const side = z.enum(["government", "opposition"]);
const position = z.union([z.literal(1), z.literal(2)]);

const tournamentSchema = z.object({
  id: uuid,
  organisationId: uuid,
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["live", "sandbox", "demo"]),
  status: z.enum(["setup", "running", "complete", "archived"]),
  schemaVersion: z.int(),
  revision: z.int().min(0),
  joinCode: nullableText,
  settings: z.unknown(),
  scoringPolicy: jsonRecord,
  drawSeed: nullableText,
  demoTemplate: nullableText.optional(),
  demoResetEveryMinutes: z.int().nullable().optional(),
  demoLastResetAt: nullableDate.optional(),
  demoExpiresAt: nullableDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const divisionSchema = z.object({
  id: uuid,
  code: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.int(),
  finalizedAt: nullableDate,
  finalizedBy: nullableText,
  finalizedAtRevision: z.int().nullable(),
  policySnapshot: jsonRecord.nullable(),
  createdAt: isoDate,
});

const roomSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  sortOrder: z.int(),
  createdAt: isoDate,
});

const roundSchema = z.object({
  id: uuid,
  number: z.int().min(1),
  format: z.enum(["prepared", "impromptu"]),
  sidesDecided: z.enum(["in-advance", "in-room"]),
  status: z.enum(["pending", "open", "closed"]),
  closedAt: nullableDate.optional().default(null),
  createdAt: isoDate,
});

const teamSchema = z.object({
  id: uuid,
  divisionCode: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  school: z.string().min(1),
  seed: z.int().nullable(),
  status: z.enum(["active", "withdrawn"]),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const speakerSchema = z.object({
  id: uuid,
  teamId: uuid,
  position,
  name: z.string().min(1),
  status: z.enum(["active", "absent"]),
  createdAt: isoDate,
});

const judgeSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  /** Null when the backup was exported without secrets; regenerated on import. */
  code: nullableText,
  joinTokenHash: nullableText,
  sessionEpoch: z.int().min(0),
  homeRoomId: uuid.nullable(),
  status: z.enum(["active", "withdrawn"]),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const actualSidesSchema = z.object({
  governmentTeamId: z.string(),
  recordedBy: z.string(),
  at: z.string(),
});

const debateSchema = z.object({
  id: uuid,
  divisionCode: z.string().min(1),
  round: z.int().min(1),
  roomId: uuid,
  governmentTeamId: uuid,
  oppositionTeamId: uuid,
  motion: z.string(),
  actualSides: actualSidesSchema.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const debateTeamSchema = z.object({
  debateId: uuid,
  round: z.int().min(1),
  teamId: uuid,
  side,
});

const debateJudgeSchema = z.object({
  debateId: uuid,
  round: z.int().min(1),
  judgeId: uuid,
  seat: z.int().min(1).max(5),
});

const identitySchema = z.object({
  debateId: z.string(),
  divisionCode: z.string(),
  round: z.int(),
  judgeId: z.string(),
  governmentTeamId: z.string(),
  oppositionTeamId: z.string(),
  speakers: z.array(z.object({ id: z.string(), teamId: z.string(), side, position })),
});

const teamCardSchema = z.object({
  teamId: z.string(),
  code: z.string(),
  name: z.string(),
  school: z.string(),
});

const displaySchema = z.object({
  roomName: z.string(),
  judgeName: z.string(),
  roundFormat: z.enum(["prepared", "impromptu"]),
  sidesDecided: z.enum(["in-advance", "in-room"]),
  motion: z.string(),
  government: teamCardSchema,
  opposition: teamCardSchema,
  speakers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      side,
      position,
      role: z.enum(["pm", "lo", "gm", "om"]),
    }),
  ),
});

const assignmentSchema = z.object({
  id: z.string().min(1),
  debateId: uuid,
  judgeId: uuid,
  identity: identitySchema,
  identityHash: z.string(),
  display: displaySchema,
  scheduleRevision: z.int(),
  createdAt: isoDate,
  retiredAt: nullableDate,
  retiredReason: nullableText,
  successorId: nullableText,
});

const speakerScoreSchema = z.object({
  argumentation: z.number(),
  rebuttal: z.number(),
  presentation: z.number(),
  poi: z.number(),
  overall: z.number(),
  www: z.string(),
  ebi: z.string(),
});
const scoresSchema = z.record(z.string(), speakerScoreSchema);
const roleSwapsSchema = z.record(z.string(), z.boolean());

const sheetVersionSchema = z.object({
  id: uuid,
  assignmentId: z.string().min(1),
  version: z.int().min(1),
  scores: scoresSchema,
  sideFlipped: z.boolean(),
  roleSwaps: roleSwapsSchema,
  source: z.enum([
    "judge",
    "judge_handoff",
    "organiser_paper",
    "organiser_correction",
    "organiser_resolution",
    "simulated",
    "import",
  ]),
  actorType: z.enum(["organiser", "judge", "system", "demo"]),
  actorId: nullableText,
  actorName: nullableText,
  reason: nullableText,
  requestKey: nullableText,
  receivedAt: isoDate,
});

const sheetSchema = z.object({
  assignmentId: z.string().min(1),
  version: z.int().min(1),
  currentVersionId: uuid,
  updatedAt: isoDate,
});

const submissionSchema = z.object({
  judgeId: uuid,
  requestId: z.string().min(1),
  assignmentId: z.string().min(1),
  fingerprint: z.string(),
  state: z.enum(["pending", "done"]),
  httpStatus: z.int().nullable(),
  response: jsonRecord.nullable(),
  createdAt: isoDate,
  completedAt: nullableDate,
});

const payloadSchema = z.object({
  scores: scoresSchema,
  sideFlipped: z.boolean(),
  roleSwaps: roleSwapsSchema,
});

const conflictSchema = z.object({
  id: uuid,
  assignmentId: z.string().min(1),
  judgeId: uuid,
  requestId: z.string().min(1),
  kind: z.enum(["version", "comments_only"]),
  incoming: payloadSchema,
  baseVersion: z.int(),
  currentVersion: z.int(),
  status: z.enum(["open", "resolved", "superseded"]),
  resolution: z
    .object({
      choice: z.enum(["keep", "incoming", "merge_comments"]),
      reason: z.string(),
      resolvedBy: z.string(),
      resolvedAt: z.string(),
      resultingVersion: z.int(),
    })
    .nullable(),
  resolvedAt: nullableDate,
  createdAt: isoDate,
});

const sheetWaiverSchema = z.object({
  id: uuid,
  assignmentId: z.string().min(1),
  reason: z.string().min(1),
  createdBy: nullableText,
  createdAt: isoDate,
  revokedAt: nullableDate,
  revokedBy: nullableText,
  revokedReason: nullableText,
});

const scoreOverrideSchema = z.object({
  id: uuid,
  divisionCode: z.string().min(1),
  speakerId: uuid.nullable(),
  teamId: uuid.nullable(),
  round: z.int().nullable(),
  assignmentId: z.string().nullable(),
  kind: z.enum([
    "force_include",
    "force_exclude",
    "keep_all_for_debater",
    "exclude_debater",
    "waive_missing_sheet",
    "rank_single_speaker_team",
  ]),
  reason: z.string().min(1),
  createdBy: nullableText,
  createdAt: isoDate,
  revokedAt: nullableDate,
  revokedBy: nullableText,
  revokedReason: nullableText,
});

const checklistOverrideSchema = z.object({
  id: uuid,
  stepKey: z.string().min(1),
  state: z.enum(["done", "skipped"]),
  reason: z.string().min(1),
  createdBy: nullableText,
  createdAt: isoDate,
  revokedAt: nullableDate,
  revokedBy: nullableText,
});

const tablesSchema = z.object({
  divisions: z.array(divisionSchema),
  rooms: z.array(roomSchema),
  rounds: z.array(roundSchema),
  teams: z.array(teamSchema),
  speakers: z.array(speakerSchema),
  judges: z.array(judgeSchema),
  debates: z.array(debateSchema),
  debateTeams: z.array(debateTeamSchema),
  debateJudges: z.array(debateJudgeSchema),
  assignments: z.array(assignmentSchema),
  sheets: z.array(sheetSchema),
  sheetVersions: z.array(sheetVersionSchema),
  submissions: z.array(submissionSchema).default([]),
  conflicts: z.array(conflictSchema),
  sheetWaivers: z.array(sheetWaiverSchema),
  scoreOverrides: z.array(scoreOverrideSchema),
  checklistOverrides: z.array(checklistOverrideSchema).default([]),
  /** Kept for the record only; never imported. */
  auditLog: z.array(jsonRecord).default([]),
});

/** The outer envelope. `tables` stays loose here so the checksum is taken over the raw object. */
const envelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT, { error: "This file is not a Dais backup." }),
  schemaVersion: z.int(),
  appVersion: z.string(),
  exportedAt: isoDate,
  tournament: tournamentSchema,
  tables: jsonRecord,
  checksum: z.string().length(64),
});

export type BackupTournament = z.infer<typeof tournamentSchema>;
export type BackupTables = z.infer<typeof tablesSchema>;
export type BackupAssignment = z.infer<typeof assignmentSchema>;
export type BackupJudge = z.infer<typeof judgeSchema>;

/** The whole document, as `exportBackup` returns it and `importBackup` reads it. */
export interface Backup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  tournament: BackupTournament;
  tables: BackupTables;
  /** sha256 over the canonical JSON of `tables`. */
  checksum: string;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportBackupOptions {
  /** Include judge codes, join-token hashes and the tournament join code. Owners only. */
  includeSecrets?: boolean;
}

/** sha256 over the canonical JSON of the tables, so key order can never change it. */
export function backupChecksum(tables: unknown): string {
  return sha256Hex(canonicalJson(tables));
}

/**
 * Reads the whole tournament into a backup document. Row order is fixed
 * (see `loadGraph` and the queries below), so two exports of the same state
 * are byte-for-byte equal apart from `exportedAt`.
 *
 * Every read happens in one read-only, repeatable-read transaction, so the
 * document describes one moment: a draw saved or a sheet received while
 * the export runs is either wholly in the file or wholly out of it. On a
 * pooled connection, separate reads could otherwise land on different
 * connections and see different committed states.
 */
export async function exportBackup(
  ctx: ServiceContext,
  tournamentId: string,
  options: ExportBackupOptions = {},
): Promise<Backup> {
  return withTransaction(ctx, async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    return readBackup(tx, tournamentId, options.includeSecrets ?? false, ctx.now());
  });
}

/** The export proper, on whatever handle the caller holds. */
async function readBackup(
  db: Queryable,
  tournamentId: string,
  includeSecrets: boolean,
  exportedAt: Date,
): Promise<Backup> {
  const graph = await loadGraph(db, tournamentId, {
    includeResolved: true,
    includeRevoked: true,
    includeVersions: true,
  });
  const submissionRows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.tournamentId, tournamentId))
    .orderBy(asc(submissions.judgeId), asc(submissions.requestId));
  const checklistRows = await db
    .select()
    .from(checklistOverrides)
    .where(eq(checklistOverrides.tournamentId, tournamentId))
    .orderBy(asc(checklistOverrides.createdAt), asc(checklistOverrides.id));
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tournamentId, tournamentId))
    .orderBy(asc(auditLog.id));

  const tables = asJson<BackupTables>({
    divisions: graph.divisions,
    rooms: graph.rooms,
    rounds: graph.rounds,
    teams: graph.teams,
    speakers: graph.speakers,
    judges: graph.judges.map((judge) =>
      includeSecrets ? judge : { ...judge, code: null, joinTokenHash: null },
    ),
    debates: graph.debates,
    debateTeams: graph.debateTeams,
    debateJudges: graph.debateJudges,
    assignments: graph.assignments.map(withoutLiveFlag),
    sheets: graph.sheets.map((sheet) => ({
      tournamentId: sheet.tournamentId,
      assignmentId: sheet.assignmentId,
      version: sheet.version,
      currentVersionId: sheet.currentVersionId,
      updatedAt: sheet.updatedAt,
    })),
    sheetVersions: graph.sheetVersions ?? [],
    submissions: submissionRows,
    conflicts: graph.conflicts,
    sheetWaivers: graph.sheetWaivers,
    scoreOverrides: graph.scoreOverrides,
    checklistOverrides: checklistRows,
    auditLog: auditRows,
  });
  const tournament = asJson<BackupTournament>(
    includeSecrets ? graph.tournament : { ...graph.tournament, joinCode: null },
  );
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: packageJson.version,
    exportedAt: exportedAt.toISOString(),
    tournament,
    tables,
    checksum: backupChecksum(tables),
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Validates an uploaded document: the envelope, the schema version, the
 * checksum over the raw tables, and then every row. Throws
 * `errors.validation` with plain messages; never a zod error.
 */
export function parseBackup(input: unknown): Backup {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw validationFromZod(envelope.error, "This file is not a Dais backup that can be read.");
  }
  if (envelope.data.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw errors.validation(
      "This backup was made by a newer version of Dais. Update before importing it.",
    );
  }
  if (backupChecksum(envelope.data.tables) !== envelope.data.checksum) {
    throw errors.validation(
      "The backup's checksum does not match its contents. The file may be damaged.",
    );
  }
  const tables = tablesSchema.safeParse(envelope.data.tables);
  if (!tables.success) {
    throw validationFromZod(
      tables.error,
      "Some rows in this backup are not in the expected shape.",
    );
  }
  return { ...envelope.data, format: BACKUP_FORMAT, tables: tables.data };
}

/**
 * The tables and tournament row held in a `tournament_snapshots` body, in
 * the backup shape, so a snapshot restores through the same code as a
 * backup. Snapshots carry no submissions or checklist overrides.
 */
export function tablesFromSnapshot(body: unknown): {
  tournament: BackupTournament;
  tables: BackupTables;
} {
  const graph = (body as { graph?: Partial<TournamentGraph> } | null)?.graph;
  if (!graph || typeof graph !== "object") {
    throw errors.internal(new Error("The snapshot body has no graph."));
  }
  const graphSheets = graph.sheets ?? [];
  const candidate = {
    divisions: graph.divisions ?? [],
    rooms: graph.rooms ?? [],
    rounds: graph.rounds ?? [],
    teams: graph.teams ?? [],
    speakers: graph.speakers ?? [],
    judges: graph.judges ?? [],
    debates: graph.debates ?? [],
    debateTeams: graph.debateTeams ?? [],
    debateJudges: graph.debateJudges ?? [],
    assignments: graph.assignments ?? [],
    sheets: graphSheets.map((sheet) => ({
      assignmentId: sheet.assignmentId,
      version: sheet.version,
      currentVersionId: sheet.currentVersionId,
      updatedAt: sheet.updatedAt,
    })),
    sheetVersions: graph.sheetVersions ?? [],
    submissions: [],
    conflicts: graph.conflicts ?? [],
    sheetWaivers: graph.sheetWaivers ?? [],
    scoreOverrides: graph.scoreOverrides ?? [],
    checklistOverrides: [],
    auditLog: [],
  };
  const tournament = tournamentSchema.safeParse(graph.tournament);
  const tables = tablesSchema.safeParse(candidate);
  if (!tournament.success || !tables.success) {
    throw errors.internal(new Error("The snapshot body is not in the expected shape."));
  }
  return { tournament: tournament.data, tables: tables.data };
}

// ---------------------------------------------------------------------------
// Import as a new tournament
// ---------------------------------------------------------------------------

export interface ImportBackupInput {
  organisationId: string;
  /** The uploaded document, still unvalidated. */
  backup: unknown;
  mode: "new";
  kind: TournamentRow["kind"];
  /** Defaults to the backup's name with "(copy)". */
  name?: string;
  /** Defaults to the backup's slug with a "-copy-xxxx" suffix. Must be free in the organisation. */
  slug?: string;
  /** Leave the sheets, conflicts, waivers and overrides behind: a practice copy. */
  clearScores?: boolean;
}

export interface ImportBackupResult {
  tournamentId: string;
  slug: string;
  joinCode: string;
  checksum: string;
  clearedScores: boolean;
  /** The creation snapshot, for a sandbox or demo copy; what `resetSandbox` returns to. */
  snapshotId: string | null;
  counts: { teams: number; judges: number; debates: number; assignments: number; sheets: number };
}

/**
 * Creates a new tournament from a backup. Every uuid is replaced and every
 * reference follows; assignment ids are derived afresh (see the file
 * comment). Judges keep their codes when the backup has them and always get
 * new join tokens, because the token hash is unique across the database
 * and the copy may sit beside the original.
 *
 * With `clearScores` the copy is a practice copy: no sheets, and also no
 * published results, no closed rounds and no sides recorded from the room,
 * because those belong to the day that was scored, not to the setup.
 *
 * A copy of kind `demo` expires like any other demo; a `sandbox` or `demo`
 * copy ends with a creation snapshot so it can be reset.
 */
export async function importBackup(
  ctx: ServiceContext,
  input: ImportBackupInput,
): Promise<ImportBackupResult> {
  const backup = parseBackup(input.backup);
  const settings = settingsOfBackup(backup.tournament);
  const clearScores = input.clearScores ?? false;

  return withTransaction(ctx, async (tx) => {
    const [organisation] = await tx
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .limit(1);
    if (!organisation) throw errors.notFound("That organisation");

    const slug = await resolveSlug(tx, input.organisationId, input.slug, backup.tournament.slug);
    const tournamentId = newId();
    const now = ctx.now();
    const code = await insertTournamentRow(tx, {
      id: tournamentId,
      organisationId: input.organisationId,
      slug,
      name: input.name?.trim() || `${backup.tournament.name} (copy)`,
      kind: input.kind,
      status: clearScores ? "setup" : backup.tournament.status,
      revision: backup.tournament.revision,
      settings,
      scoringPolicy: backup.tournament.scoringPolicy,
      drawSeed: backup.tournament.drawSeed,
      demoExpiresAt: input.kind === "demo" ? new Date(now.getTime() + DEMO_LIFETIME_MS) : null,
      createdAt: now,
      updatedAt: now,
    });

    const ids = new IdRemap(backup.tables);
    const setup = remapSetupTables(backup.tables, ids, { clearScores });
    await insertSetupRows(tx, tournamentId, setup, { freshJoinTokens: true });

    const assignmentRows = await remapAssignments(tx, tournamentId, backup.tables.assignments, ids);
    await insertAssignmentRows(tx, tournamentId, assignmentRows.rows);

    let sheetCount = 0;
    if (!clearScores) {
      const scored = remapScoreTables(backup.tables, ids, assignmentRows.byOldId);
      await insertScoreRows(tx, tournamentId, scored);
      sheetCount = scored.sheets.length;
    }
    await insertChecklistRows(
      tx,
      tournamentId,
      backup.tables.checklistOverrides.map((row) => ({ ...row, id: ids.of(row.id) })),
    );

    await recordAudit(tx, ctx, {
      tournamentId,
      action: AUDIT_ACTIONS.backupImported,
      entityType: "tournament",
      entityId: tournamentId,
      after: {
        checksum: backup.checksum,
        sourceTournamentId: backup.tournament.id,
        exportedAt: backup.exportedAt,
        clearScores,
      },
    });
    const snapshot =
      input.kind === "live"
        ? null
        : await snapshotTournament(tx, ctx, tournamentId, "manual", {
            label: CREATION_SNAPSHOT_LABEL,
          });
    ctx.log.info(
      { tournamentId, sourceTournamentId: backup.tournament.id, clearScores },
      "Backup imported as a new tournament",
    );
    return {
      tournamentId,
      slug,
      joinCode: code,
      checksum: backup.checksum,
      clearedScores: clearScores,
      snapshotId: snapshot?.id ?? null,
      counts: {
        teams: setup.teams.length,
        judges: setup.judges.length,
        debates: setup.debates.length,
        assignments: assignmentRows.rows.length,
        sheets: sheetCount,
      },
    };
  });
}

/** The backup's settings, parsed; a backup with broken settings is refused. */
function settingsOfBackup(tournament: BackupTournament) {
  const parsed = parseSettings(tournament.settings);
  if (parsed.ok) return parsed.data;
  throw errors.validation("The tournament settings in this backup are not valid.", {
    issues: parsed.errors,
  });
}

/** A slug that is free in the organisation: the requested one, or the backup's with a suffix. */
async function resolveSlug(
  tx: Tx,
  organisationId: string,
  requested: string | undefined,
  original: string,
): Promise<string> {
  const slug = requested?.trim()
    ? slugify(requested)
    : `${slugify(original)}-copy-${crockfordCode(4).toLowerCase()}`;
  if (!slug) throw errors.validation("Give the copy a short name for its web address.");
  const [taken] = await tx
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(and(eq(tournaments.organisationId, organisationId), eq(tournaments.slug, slug)))
    .limit(1);
  if (taken) throw slugTaken();
  return slug;
}

function slugTaken() {
  return errors.validation(
    "That short name is already used by another tournament in this organisation.",
    { issues: [{ path: "slug", message: "Choose a different short name." }] },
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** A join code no tournament uses. The unique index is case-insensitive, so the check is too. */
export async function freeJoinCode(tx: Queryable): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = joinCode();
    const [taken] = await tx
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(sql`upper(${tournaments.joinCode}) = ${code}`)
      .limit(1);
    if (!taken) return code;
  }
  throw errors.internal(new Error("Could not find a free join code after 20 attempts."));
}

/** How many join codes `insertTournamentRow` tries before giving up. */
const JOIN_CODE_ATTEMPTS = 5;

/**
 * Inserts a tournament row with a join code no other tournament uses, and
 * returns the code. `freeJoinCode` checks first, but two imports at once
 * can still pick the same code (or the same slug), and Postgres aborts the
 * transaction after a failed statement. The insert therefore runs in a
 * savepoint: a join-code clash is retried with a fresh code, a slug clash
 * becomes the same validation error `resolveSlug` gives, and the caller's
 * transaction stays usable either way.
 */
export async function insertTournamentRow(
  tx: Tx,
  values: Omit<NewTournamentRow, "joinCode">,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const code = await freeJoinCode(tx);
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(tournaments).values({ ...values, joinCode: code });
      });
      return code;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const constraint = violatedConstraint(error);
      if (constraint === "tournaments_slug_unique") throw slugTaken();
      if (constraint === "tournaments_join_code_unique" && attempt < JOIN_CODE_ATTEMPTS) continue;
      throw errors.internal(error);
    }
  }
}

/**
 * The unique constraint or index a unique-violation error names, if any.
 * node-postgres exposes it as `constraint`; both drivers quote it in the
 * message, which is the fallback. (`tournaments.ts` has the same helper;
 * it is not imported from there to keep this module free of that one.)
 */
function violatedConstraint(error: unknown): string | undefined {
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
 * Old uuid to fresh uuid for every row of the setup and score tables. Every
 * reference in the backup must resolve; a dangling one means the file was
 * edited or truncated, and the import refuses it.
 */
class IdRemap {
  private readonly fresh = new Map<string, string>();

  constructor(tables: BackupTables) {
    const owners = [
      tables.divisions,
      tables.rooms,
      tables.rounds,
      tables.teams,
      tables.speakers,
      tables.judges,
      tables.debates,
      tables.sheetVersions,
      tables.conflicts,
      tables.sheetWaivers,
      tables.scoreOverrides,
      tables.checklistOverrides,
    ];
    for (const rows of owners) {
      for (const row of rows) this.fresh.set(row.id, newId());
    }
  }

  of(oldId: string): string {
    const id = this.fresh.get(oldId);
    if (!id) {
      throw errors.validation(
        "This backup refers to a record it does not contain. The file may be incomplete.",
        { issues: [{ path: oldId, message: "Unknown id." }] },
      );
    }
    return id;
  }

  ofNullable(oldId: string | null): string | null {
    return oldId === null ? null : this.of(oldId);
  }

  /** A JSON object keyed by ids (sheet scores by debater, role swaps by team). */
  keys<T>(record: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(record)) out[this.of(key)] = value;
    return out;
  }
}

interface RemapSetupOptions {
  /** A practice copy: results not published, rounds not started, no sides recorded in the room. */
  clearScores: boolean;
}

function remapSetupTables(
  tables: BackupTables,
  ids: IdRemap,
  options: RemapSetupOptions,
): BackupTables {
  const { clearScores } = options;
  return {
    ...tables,
    divisions: tables.divisions.map((row) => ({
      ...row,
      id: ids.of(row.id),
      ...(clearScores
        ? { finalizedAt: null, finalizedBy: null, finalizedAtRevision: null, policySnapshot: null }
        : {}),
    })),
    rooms: tables.rooms.map((row) => ({ ...row, id: ids.of(row.id) })),
    rounds: tables.rounds.map((row) => ({
      ...row,
      id: ids.of(row.id),
      ...(clearScores ? { status: "pending" as const, closedAt: null } : {}),
    })),
    teams: tables.teams.map((row) => ({ ...row, id: ids.of(row.id) })),
    speakers: tables.speakers.map((row) => ({
      ...row,
      id: ids.of(row.id),
      teamId: ids.of(row.teamId),
    })),
    judges: tables.judges.map((row) => ({
      ...row,
      id: ids.of(row.id),
      homeRoomId: ids.ofNullable(row.homeRoomId),
      // A copy is a different tournament: judges' phones must not stay signed in to it.
      sessionEpoch: 0,
    })),
    debates: tables.debates.map((row) => ({
      ...row,
      id: ids.of(row.id),
      roomId: ids.of(row.roomId),
      governmentTeamId: ids.of(row.governmentTeamId),
      oppositionTeamId: ids.of(row.oppositionTeamId),
      actualSides:
        row.actualSides && !clearScores
          ? { ...row.actualSides, governmentTeamId: ids.of(row.actualSides.governmentTeamId) }
          : null,
    })),
    debateTeams: tables.debateTeams.map((row) => ({
      ...row,
      debateId: ids.of(row.debateId),
      teamId: ids.of(row.teamId),
    })),
    debateJudges: tables.debateJudges.map((row) => ({
      ...row,
      debateId: ids.of(row.debateId),
      judgeId: ids.of(row.judgeId),
    })),
  };
}

function remapIdentity(identity: AssignmentIdentity, ids: IdRemap): AssignmentIdentity {
  return {
    ...identity,
    debateId: ids.of(identity.debateId),
    judgeId: ids.of(identity.judgeId),
    governmentTeamId: ids.of(identity.governmentTeamId),
    oppositionTeamId: ids.of(identity.oppositionTeamId),
    speakers: identity.speakers.map((speaker) => ({
      ...speaker,
      id: ids.of(speaker.id),
      teamId: ids.of(speaker.teamId),
    })),
  };
}

function remapDisplay(display: AssignmentDisplay, ids: IdRemap): AssignmentDisplay {
  return {
    ...display,
    government: { ...display.government, teamId: ids.of(display.government.teamId) },
    opposition: { ...display.opposition, teamId: ids.of(display.opposition.teamId) },
    speakers: display.speakers.map((speaker) => ({
      ...speaker,
      id: ids.of(speaker.id),
      teamId: ids.of(speaker.teamId),
    })),
  };
}

interface RemappedAssignments {
  rows: BackupAssignment[];
  /** Old assignment id to new, for every assignment in the backup. */
  byOldId: Map<string, string>;
}

/**
 * Assignment ids for the new tournament. The setup rows are already in, so
 * the live set is derived exactly as the draw page would derive it; each
 * live assignment in the backup is matched to the derived one by (debate,
 * judge) slot and keeps its creation time. A retired assignment gets an id
 * hashed from its remapped identity and its old id, which keeps every id
 * distinct even when a slot went through the same matchup twice.
 */
async function remapAssignments(
  tx: Tx,
  tournamentId: string,
  rows: readonly BackupAssignment[],
  ids: IdRemap,
): Promise<RemappedAssignments> {
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const derived = deriveAssignments(schedule, []);
  if (derived.skipped.length) {
    throw errors.validation(
      "The draw in this backup refers to a team, judge or room it does not contain.",
      {
        issues: derived.skipped.map((slot) => ({ path: slot.debateId, message: slot.reason })),
      },
    );
  }
  const derivedBySlot = new Map(
    derived.assignments.map((a) => [slotKey(a.identity.debateId, a.identity.judgeId), a]),
  );

  const byOldId = new Map<string, string>();
  const out: BackupAssignment[] = [];
  const liveSlotsSeen = new Set<string>();
  for (const row of rows) {
    const identity = remapIdentity(row.identity, ids);
    const display = remapDisplay(row.display, ids);
    if (row.retiredAt === null) {
      const key = slotKey(identity.debateId, identity.judgeId);
      const live = derivedBySlot.get(key);
      if (!live) {
        throw errors.validation("The sheets in this backup do not match its draw.", {
          issues: [{ path: row.id, message: "A live sheet has no slot in the draw." }],
        });
      }
      liveSlotsSeen.add(key);
      byOldId.set(row.id, live.id);
      out.push({
        ...row,
        id: live.id,
        debateId: identity.debateId,
        judgeId: identity.judgeId,
        identity: live.identity,
        identityHash: sha256Hex(canonicalJson(live.identity)),
        display: live.display,
        scheduleRevision: live.scheduleRevision,
        successorId: null,
      });
      continue;
    }
    const id = hashAssignmentId(identity, [row.id], row.scheduleRevision);
    byOldId.set(row.id, id);
    out.push({
      ...row,
      id,
      debateId: identity.debateId,
      judgeId: identity.judgeId,
      identity,
      identityHash: sha256Hex(canonicalJson(identity)),
      display,
    });
  }
  // Successors point at live ids, which are now known.
  for (const row of out) {
    if (row.successorId !== null) row.successorId = byOldId.get(row.successorId) ?? null;
  }
  // Slots the draw has but the backup's assignments lack are simply new.
  const nowIso = new Date().toISOString();
  for (const [key, live] of derivedBySlot) {
    if (liveSlotsSeen.has(key)) continue;
    out.push({
      id: live.id,
      debateId: live.identity.debateId,
      judgeId: live.identity.judgeId,
      identity: live.identity,
      identityHash: sha256Hex(canonicalJson(live.identity)),
      display: live.display,
      scheduleRevision: live.scheduleRevision,
      createdAt: nowIso,
      retiredAt: null,
      retiredReason: null,
      successorId: null,
    });
  }
  return { rows: out, byOldId };
}

/** The score tables with every id, assignment id and id-keyed JSON object remapped. */
function remapScoreTables(
  tables: BackupTables,
  ids: IdRemap,
  assignmentIds: Map<string, string>,
): BackupTables {
  const asg = (oldId: string): string => {
    const id = assignmentIds.get(oldId);
    if (!id) {
      throw errors.validation("This backup has a sheet for a slot it does not describe.", {
        issues: [{ path: oldId, message: "Unknown sheet." }],
      });
    }
    return id;
  };
  const payload = (p: SheetPayload): SheetPayload => ({
    scores: ids.keys(p.scores) as SheetScores,
    sideFlipped: p.sideFlipped,
    roleSwaps: ids.keys(p.roleSwaps),
  });
  return {
    ...tables,
    sheetVersions: tables.sheetVersions.map((row) => ({
      ...row,
      id: ids.of(row.id),
      assignmentId: asg(row.assignmentId),
      scores: ids.keys(row.scores),
      roleSwaps: ids.keys(row.roleSwaps),
    })),
    sheets: tables.sheets.map((row) => ({
      ...row,
      assignmentId: asg(row.assignmentId),
      currentVersionId: ids.of(row.currentVersionId),
    })),
    submissions: tables.submissions.map((row) => ({
      ...row,
      judgeId: ids.of(row.judgeId),
      assignmentId: assignmentIds.get(row.assignmentId) ?? row.assignmentId,
    })),
    conflicts: tables.conflicts.map((row) => ({
      ...row,
      id: ids.of(row.id),
      assignmentId: asg(row.assignmentId),
      judgeId: ids.of(row.judgeId),
      incoming: payload(row.incoming),
    })),
    sheetWaivers: tables.sheetWaivers.map((row) => ({
      ...row,
      id: ids.of(row.id),
      assignmentId: asg(row.assignmentId),
    })),
    scoreOverrides: tables.scoreOverrides.map((row) => ({
      ...row,
      id: ids.of(row.id),
      speakerId: ids.ofNullable(row.speakerId),
      teamId: ids.ofNullable(row.teamId),
      assignmentId: row.assignmentId === null ? null : asg(row.assignmentId),
    })),
  };
}

// ---------------------------------------------------------------------------
// Restore in place
// ---------------------------------------------------------------------------

export interface RestoreInPlaceInput {
  tournamentId: string;
  /** The uploaded document, still unvalidated. */
  backup: unknown;
  /** The organiser types the tournament's slug to confirm they mean it. */
  confirmSlug: string;
  reason: string;
}

export interface RestoreInPlaceResult {
  /** The pre-restore snapshot, in case the restore was the mistake. */
  snapshotId: string;
  checksum: string;
  restoredAt: string;
  revision: number;
}

/**
 * Replaces the tournament's rows with the backup's, keeping the original
 * ids. Judge sessions are removed, because
 * the sheets a phone knows about may no longer exist; judges sign in again
 * with the card they already hold: a judge's code and join token are kept
 * from the current row, including the epoch that signs their QR link.
 * Session deletion invalidates every old cookie without rotating that link.
 * Only a judge the tournament did not have gets
 * a fresh code and token. The tournament's own row keeps its slug, name,
 * kind and organisation, and takes the backup's settings, policy, seed and
 * status; the revision moves forward and the restored schedule is stored
 * as a setup revision, so a later draw save never collides with history.
 */
export async function restoreInPlace(
  ctx: ServiceContext,
  input: RestoreInPlaceInput,
): Promise<RestoreInPlaceResult> {
  const backup = parseBackup(input.backup);
  const settings = settingsOfBackup(backup.tournament);
  if (!input.reason.trim()) {
    throw errors.validation("Give a reason for the restore. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }

  return withTransaction(ctx, async (tx) => {
    const [current] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, input.tournamentId))
      .for("update");
    if (!current) throw errors.notFound("That tournament");
    if (input.confirmSlug.trim() !== current.slug) {
      throw errors.validation("Type the tournament's short name exactly to confirm the restore.", {
        issues: [{ path: "confirmSlug", message: "The short name does not match." }],
      });
    }
    if (backup.tournament.id !== current.id) {
      throw errors.validation(
        "This backup belongs to a different tournament. Import it as a new tournament instead.",
      );
    }

    const snapshot = await snapshotTournament(tx, ctx, current.id, "pre_restore", {
      label: "Before restoring a backup",
    });
    const judgesBefore = await currentJudges(tx, current.id);
    await deleteTournamentChildren(tx, current.id);

    const judgeEpochs = new Map<string, number>();
    for (const judge of backup.tables.judges) {
      const before = judgesBefore.get(judge.id);
      judgeEpochs.set(judge.id, before?.sessionEpoch ?? judge.sessionEpoch);
    }
    await insertTournamentTables(tx, current.id, backup.tables, {
      judgeEpochs,
      judgeSecrets: judgesBefore,
    });

    const now = ctx.now();
    const revision = Math.max(current.revision, backup.tournament.revision) + 1;
    await tx
      .update(tournaments)
      .set({
        settings,
        scoringPolicy: backup.tournament.scoringPolicy,
        drawSeed: backup.tournament.drawSeed,
        status: backup.tournament.status,
        revision,
        updatedAt: now,
      })
      .where(eq(tournaments.id, current.id));
    await recordSetupRevision(tx, ctx, current.id, revision);

    await recordAudit(tx, ctx, {
      tournamentId: current.id,
      action: AUDIT_ACTIONS.backupRestored,
      entityType: "tournament",
      entityId: current.id,
      reason: input.reason,
      before: { revision: current.revision, snapshotId: snapshot.id },
      after: { revision, checksum: backup.checksum, exportedAt: backup.exportedAt },
    });
    ctx.log.info(
      { tournamentId: current.id, snapshotId: snapshot.id, revision },
      "Backup restored in place",
    );
    return {
      snapshotId: snapshot.id,
      checksum: backup.checksum,
      restoredAt: now.toISOString(),
      revision,
    };
  });
}

/** What a restore keeps of each judge it is about to replace, by judge id. */
export interface JudgeSecrets {
  code: string;
  joinTokenHash: string;
  sessionEpoch: number;
}

async function currentJudges(tx: Tx, tournamentId: string): Promise<Map<string, JudgeSecrets>> {
  const rows = await tx
    .select({
      id: judges.id,
      code: judges.code,
      joinTokenHash: judges.joinTokenHash,
      sessionEpoch: judges.sessionEpoch,
    })
    .from(judges)
    .where(eq(judges.tournamentId, tournamentId));
  return new Map(rows.map(({ id, ...secrets }) => [id, secrets]));
}

/**
 * Stores the tournament's current schedule as the setup revision `revision`,
 * as a draw save does. A restore or reset that moves the revision forward
 * records one so the history of "what the draw was at revision N" has no
 * gap and the next draw save (which inserts `revision + 1`) never lands on
 * a row that already exists.
 */
export async function recordSetupRevision(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  revision: number,
): Promise<void> {
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  await tx.insert(setupRevisions).values({
    tournamentId,
    revision,
    snapshot: { ...schedule, revision },
    author: ctx.actor.name,
    at: ctx.now(),
  });
}

// ---------------------------------------------------------------------------
// Shared delete and insert, in foreign-key order
// ---------------------------------------------------------------------------

/**
 * Removes every row below the tournament, children before parents, so no
 * `NO ACTION` foreign key is left dangling at the end of any statement.
 * Snapshots, setup revisions and the audit log stay: they are history.
 * Sessions of the tournament's judges go too, because the judges do.
 */
export async function deleteTournamentChildren(tx: Tx, tournamentId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.tournamentId, tournamentId));
  await tx.delete(sheets).where(eq(sheets.tournamentId, tournamentId));
  await tx.delete(conflicts).where(eq(conflicts.tournamentId, tournamentId));
  await tx.delete(sheetWaivers).where(eq(sheetWaivers.tournamentId, tournamentId));
  await tx.delete(scoreOverrides).where(eq(scoreOverrides.tournamentId, tournamentId));
  await tx.delete(submissions).where(eq(submissions.tournamentId, tournamentId));
  await tx.delete(sheetVersions).where(eq(sheetVersions.tournamentId, tournamentId));
  await tx.delete(judgeDevices).where(eq(judgeDevices.tournamentId, tournamentId));
  await tx.delete(assignments).where(eq(assignments.tournamentId, tournamentId));
  await tx.delete(debateJudges).where(eq(debateJudges.tournamentId, tournamentId));
  await tx.delete(debateTeams).where(eq(debateTeams.tournamentId, tournamentId));
  await tx.delete(debates).where(eq(debates.tournamentId, tournamentId));
  await tx.delete(speakers).where(eq(speakers.tournamentId, tournamentId));
  await tx.delete(teams).where(eq(teams.tournamentId, tournamentId));
  await tx.delete(judges).where(eq(judges.tournamentId, tournamentId));
  await tx.delete(rooms).where(eq(rooms.tournamentId, tournamentId));
  await tx.delete(rounds).where(eq(rounds.tournamentId, tournamentId));
  await tx.delete(divisions).where(eq(divisions.tournamentId, tournamentId));
  await tx.delete(checklistOverrides).where(eq(checklistOverrides.tournamentId, tournamentId));
}

export interface InsertTablesOptions {
  /** Session epoch per judge id, when the caller wants judges signed out. */
  judgeEpochs?: Map<string, number>;
  /**
   * Code and join token to keep for a judge whose backup row has none, by
   * judge id: the rows a restore is replacing, so printed cards stay valid.
   */
  judgeSecrets?: ReadonlyMap<string, JudgeSecrets>;
  /**
   * Give every judge a new join token whatever the backup holds. A copy
   * must never share a token with the tournament it was copied from: the
   * hash is unique across the database, and a shared card would sign a
   * judge into the wrong tournament.
   */
  freshJoinTokens?: boolean;
}

/** Inserts every table of a backup under `tournamentId`, parents before children. */
export async function insertTournamentTables(
  tx: Tx,
  tournamentId: string,
  tables: BackupTables,
  options: InsertTablesOptions = {},
): Promise<void> {
  await insertSetupRows(tx, tournamentId, tables, options);
  await insertAssignmentRows(tx, tournamentId, tables.assignments);
  await insertScoreRows(tx, tournamentId, tables);
  await insertChecklistRows(tx, tournamentId, tables.checklistOverrides);
}

async function insertSetupRows(
  tx: Tx,
  tournamentId: string,
  tables: BackupTables,
  options: InsertTablesOptions,
): Promise<void> {
  if (tables.divisions.length) {
    await tx.insert(divisions).values(
      tables.divisions.map((row) => ({
        ...row,
        tournamentId,
        finalizedAt: dateOrNull(row.finalizedAt),
        createdAt: date(row.createdAt),
      })),
    );
  }
  if (tables.rooms.length) {
    await tx
      .insert(rooms)
      .values(
        tables.rooms.map((row) => ({ ...row, tournamentId, createdAt: date(row.createdAt) })),
      );
  }
  if (tables.rounds.length) {
    await tx.insert(rounds).values(
      tables.rounds.map((row) => ({
        ...row,
        tournamentId,
        closedAt: dateOrNull(row.closedAt),
        createdAt: date(row.createdAt),
      })),
    );
  }
  if (tables.teams.length) {
    await tx.insert(teams).values(
      tables.teams.map((row) => ({
        ...row,
        tournamentId,
        createdAt: date(row.createdAt),
        updatedAt: date(row.updatedAt),
      })),
    );
  }
  if (tables.speakers.length) {
    await tx
      .insert(speakers)
      .values(
        tables.speakers.map((row) => ({ ...row, tournamentId, createdAt: date(row.createdAt) })),
      );
  }
  if (tables.judges.length) await insertJudgeRows(tx, tournamentId, tables.judges, options);
  if (tables.debates.length) {
    await tx.insert(debates).values(
      tables.debates.map((row) => ({
        id: row.id,
        tournamentId,
        divisionCode: row.divisionCode,
        round: row.round,
        roomId: row.roomId,
        governmentTeamId: row.governmentTeamId,
        oppositionTeamId: row.oppositionTeamId,
        motion: row.motion,
        actualSides: row.actualSides,
        createdAt: date(row.createdAt),
        updatedAt: date(row.updatedAt),
      })),
    );
  }
  if (tables.debateTeams.length) {
    await tx
      .insert(debateTeams)
      .values(tables.debateTeams.map((row) => ({ ...row, tournamentId })));
  }
  if (tables.debateJudges.length) {
    await tx
      .insert(debateJudges)
      .values(tables.debateJudges.map((row) => ({ ...row, tournamentId })));
  }
}

/**
 * Inserts the judges with their secrets resolved (see `InsertTablesOptions`
 * and the file comment). The database's unique indexes are the last line
 * of defence; a clash there is reported as a validation error, never as a
 * driver error.
 */
async function insertJudgeRows(
  tx: Tx,
  tournamentId: string,
  rows: readonly BackupJudge[],
  options: InsertTablesOptions,
): Promise<void> {
  const usedCodes = new Set<string>();
  const values = rows.map((row) => {
    const kept = options.judgeSecrets?.get(row.id);
    return {
      ...row,
      tournamentId,
      code: judgeCode(kept?.code ?? row.code ?? null, usedCodes),
      joinTokenHash: options.freshJoinTokens
        ? hashToken(randomToken())
        : (kept?.joinTokenHash ?? row.joinTokenHash ?? hashToken(randomToken())),
      sessionEpoch: options.judgeEpochs?.get(row.id) ?? row.sessionEpoch,
      createdAt: date(row.createdAt),
      updatedAt: date(row.updatedAt),
    };
  });
  try {
    await tx.insert(judges).values(values);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw errors.validation(
      "A judge in this backup has a code or join link that is already in use. Export the backup again and try once more.",
      { issues: [{ path: "judges", message: violatedConstraint(error) ?? "Unique clash." }] },
    );
  }
}

/**
 * The judge's code as given, or a fresh six-symbol Crockford code when
 * there is none. Codes are case-insensitive per tournament, so the clash
 * check upper-cases; two given codes that clash mean an edited file.
 */
function judgeCode(given: string | null, used: Set<string>): string {
  let code = given ?? "";
  if (code && used.has(code.toUpperCase())) {
    throw errors.validation("Two judges in this backup share one code.");
  }
  while (!code || used.has(code.toUpperCase())) code = crockfordCode(6);
  used.add(code.toUpperCase());
  return code;
}

async function insertAssignmentRows(
  tx: Tx,
  tournamentId: string,
  rows: readonly BackupAssignment[],
): Promise<void> {
  if (!rows.length) return;
  await tx.insert(assignments).values(
    rows.map((row) => ({
      ...row,
      tournamentId,
      createdAt: date(row.createdAt),
      retiredAt: dateOrNull(row.retiredAt),
    })),
  );
}

async function insertScoreRows(tx: Tx, tournamentId: string, tables: BackupTables): Promise<void> {
  if (tables.sheetVersions.length) {
    await tx.insert(sheetVersions).values(
      tables.sheetVersions.map((row) => ({
        ...row,
        tournamentId,
        receivedAt: date(row.receivedAt),
      })),
    );
  }
  if (tables.sheets.length) {
    await tx
      .insert(sheets)
      .values(
        tables.sheets.map((row) => ({ ...row, tournamentId, updatedAt: date(row.updatedAt) })),
      );
  }
  if (tables.submissions.length) {
    await tx.insert(submissions).values(
      tables.submissions.map((row) => ({
        ...row,
        tournamentId,
        createdAt: date(row.createdAt),
        completedAt: dateOrNull(row.completedAt),
      })),
    );
  }
  if (tables.conflicts.length) {
    await tx.insert(conflicts).values(
      tables.conflicts.map((row) => ({
        ...row,
        tournamentId,
        createdAt: date(row.createdAt),
        resolvedAt: dateOrNull(row.resolvedAt),
      })),
    );
  }
  if (tables.sheetWaivers.length) {
    await tx.insert(sheetWaivers).values(
      tables.sheetWaivers.map((row) => ({
        ...row,
        tournamentId,
        createdAt: date(row.createdAt),
        revokedAt: dateOrNull(row.revokedAt),
      })),
    );
  }
  if (tables.scoreOverrides.length) {
    await tx.insert(scoreOverrides).values(
      tables.scoreOverrides.map((row) => ({
        ...row,
        tournamentId,
        createdAt: date(row.createdAt),
        revokedAt: dateOrNull(row.revokedAt),
      })),
    );
  }
}

async function insertChecklistRows(
  tx: Tx,
  tournamentId: string,
  rows: BackupTables["checklistOverrides"],
): Promise<void> {
  if (!rows.length) return;
  await tx.insert(checklistOverrides).values(
    rows.map((row) => ({
      ...row,
      tournamentId,
      createdAt: date(row.createdAt),
      revokedAt: dateOrNull(row.revokedAt),
    })),
  );
}

// ---------------------------------------------------------------------------
// Small helpers

/** The stored columns of an assignment; `live` is derived by `loadGraph`, not stored. */
function withoutLiveFlag(assignment: GraphAssignment): AssignmentRow {
  const { live, ...row } = assignment;
  void live;
  return row;
}

/** Plain JSON: dates become ISO strings and `undefined` fields disappear. */
function asJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function date(text: string): Date {
  return new Date(text);
}

function dateOrNull(text: string | null | undefined): Date | null {
  return text === null || text === undefined ? null : new Date(text);
}
