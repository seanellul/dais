/**
 * Dais database schema (Postgres via Drizzle ORM).
 *
 * Conventions
 * - Table and column names are snake_case; TypeScript properties are camelCase.
 * - Primary keys are uuids generated in the app (`$defaultFn(randomUUID)`),
 *   never by the database, so ids are known before the row is written.
 * - Every timestamp is `timestamptz`.
 * - Every tournament-scoped table carries `tournament_id`, even where it could
 *   be derived, so scoping, export and cascade deletion are one-column filters.
 * - `ON DELETE CASCADE` exists only on foreign keys that point at `tournaments`.
 *   Every other foreign key uses the default `NO ACTION`: the app never deletes
 *   anything below a tournament (withdrawn teams and judges are status flags),
 *   and a stray manual delete is refused instead of silently rippling.
 * - Rounds and divisions are referenced by their natural keys (`round` number,
 *   `division_code`) with composite foreign keys, because that is how the pure
 *   domain (`src/domain/types.ts`) identifies them. Renaming a division code
 *   cascades through `ON UPDATE CASCADE`.
 * - Four schedule rules are declarative, not just validated in code: a room
 *   hosts one debate per round, a team debates once per round, a judge sits
 *   once per round, and two teams meet at most once (`pair_key`).
 *
 * Run `pnpm db:generate` after editing this file, then read the SQL it wrote.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AssignmentDisplay,
  AssignmentIdentity,
  Schedule,
  SheetPayload,
  SheetScores,
  TournamentSettings,
} from "../../domain/types";

// ---------------------------------------------------------------------------
// JSON column shapes that the domain does not define
// ---------------------------------------------------------------------------

/**
 * The outlier policy stored on a tournament and snapshotted on a division when
 * results are published. The scoring engine (`src/domain/scoring`) owns the
 * precise shape; the database only promises a JSON object.
 */
export type ScoringPolicyJson = Record<string, unknown>;

/** Which team actually spoke for Government after the in-room coin toss. */
export interface ActualSides {
  governmentTeamId: string;
  recordedBy: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** How an organiser settled a sheet that arrived in two versions. */
export interface ConflictResolution {
  choice: "keep" | "incoming" | "merge_comments";
  reason: string;
  resolvedBy: string;
  /** ISO 8601 timestamp. */
  resolvedAt: string;
  /** The sheet version the resolution produced. */
  resultingVersion: number;
}

/** Stored HTTP response body of a judge submission, replayed on retry. */
export type StoredResponse = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const membershipRoleEnum = pgEnum("membership_role", ["owner", "organiser"]);
export const sessionKindEnum = pgEnum("session_kind", ["organiser", "judge", "demo"]);
export const tournamentKindEnum = pgEnum("tournament_kind", ["live", "sandbox", "demo"]);
export const tournamentStatusEnum = pgEnum("tournament_status", [
  "setup",
  "running",
  "complete",
  "archived",
]);
export const roundFormatEnum = pgEnum("round_format", ["prepared", "impromptu"]);
export const sidesDecidedEnum = pgEnum("sides_decided", ["in-advance", "in-room"]);
export const roundStatusEnum = pgEnum("round_status", ["pending", "open", "closed"]);
export const teamStatusEnum = pgEnum("team_status", ["active", "withdrawn"]);
export const speakerStatusEnum = pgEnum("speaker_status", ["active", "absent"]);
export const judgeStatusEnum = pgEnum("judge_status", ["active", "withdrawn"]);
export const sideEnum = pgEnum("side", ["government", "opposition"]);
export const sheetSourceEnum = pgEnum("sheet_source", [
  "judge",
  "judge_handoff",
  "organiser_paper",
  "organiser_correction",
  "organiser_resolution",
  "simulated",
  "import",
]);
export const submissionStateEnum = pgEnum("submission_state", ["pending", "done"]);
export const conflictKindEnum = pgEnum("conflict_kind", ["version", "comments_only"]);
export const conflictStatusEnum = pgEnum("conflict_status", ["open", "resolved", "superseded"]);
export const overrideKindEnum = pgEnum("override_kind", [
  "force_include",
  "force_exclude",
  "keep_all_for_debater",
  "exclude_debater",
  "waive_missing_sheet",
  "rank_single_speaker_team",
]);
export const actorTypeEnum = pgEnum("actor_type", ["organiser", "judge", "system", "demo"]);
export const checklistStateEnum = pgEnum("checklist_state", ["done", "skipped"]);
export const snapshotKindEnum = pgEnum("snapshot_kind", [
  "manual",
  "pre_restore",
  "pre_finalize",
  "pre_unlock",
  "pre_draw_save",
  "scheduled",
]);

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** App-generated uuid primary key. */
const uuidPk = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const timestampTz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestampTz("created_at").notNull().defaultNow();
const updatedAt = () => timestampTz("updated_at").notNull().defaultNow();

/** The one place cascade deletion is allowed: from a tournament downward. */
const tournamentRef = () =>
  uuid("tournament_id")
    .notNull()
    .references(() => tournaments.id, { onDelete: "cascade" });

/** Free-text reason that must not be blank. Used with `reasonPresent`. */
const reasonRequired = () => text("reason").notNull();

// ---------------------------------------------------------------------------
// Tenancy and identity
// ---------------------------------------------------------------------------

export const organisations = pgTable("organisations", {
  id: uuidPk(),
  /** Throwaway public demo tenancy; never inferred from a user-entered name. */
  isDemo: boolean("is_demo").notNull().default(false),
  slug: text("slug").notNull().unique("organisations_slug_unique"),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  "users",
  {
    id: uuidPk(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** Null until the invite is accepted. The auth layer decides the format. */
    passwordHash: text("password_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastLoginAt: timestampTz("last_login_at"),
  },
  (t) => [uniqueIndex("users_email_unique").on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  "memberships",
  {
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRoleEnum("role").notNull().default("organiser"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "memberships_pk", columns: [t.organisationId, t.userId] }),
    index("memberships_user").on(t.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuidPk(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    email: text("email").notNull(),
    role: membershipRoleEnum("role").notNull().default("organiser"),
    /** sha256 of the invite token; the raw token lives only in the link. */
    tokenHash: text("token_hash").notNull().unique("invites_token_hash_unique"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: createdAt(),
    expiresAt: timestampTz("expires_at").notNull(),
    acceptedAt: timestampTz("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestampTz("revoked_at"),
  },
  (t) => [index("invites_organisation").on(t.organisationId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuidPk(),
    /** sha256 of the cookie token; the raw token is never stored. */
    tokenHash: text("token_hash").notNull().unique("sessions_token_hash_unique"),
    kind: sessionKindEnum("kind").notNull(),
    userId: uuid("user_id").references(() => users.id),
    judgeId: uuid("judge_id").references(() => judges.id),
    tournamentId: uuid("tournament_id").references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    organisationId: uuid("organisation_id").references(() => organisations.id),
    /** Must equal `judges.session_epoch` to stay valid; a bump revokes all. */
    epoch: integer("epoch").notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestampTz("expires_at").notNull(),
    lastSeenAt: timestampTz("last_seen_at"),
    revokedAt: timestampTz("revoked_at"),
    revokedReason: text("revoked_reason"),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
  },
  (t) => [
    index("sessions_judge_live")
      .on(t.judgeId)
      .where(sql`${t.revokedAt} is null`),
    index("sessions_user").on(t.userId),
    check(
      "sessions_kind_shape",
      sql`(${t.kind} = 'organiser' and ${t.userId} is not null)
        or (${t.kind} = 'judge' and ${t.judgeId} is not null and ${t.tournamentId} is not null)
        or (${t.kind} = 'demo' and ${t.tournamentId} is not null)`,
    ),
  ],
);

/** Token bucket per key, updated with one `UPDATE ... RETURNING`. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestampTz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tournament setup
// ---------------------------------------------------------------------------

export const tournaments = pgTable(
  "tournaments",
  {
    id: uuidPk(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: tournamentKindEnum("kind").notNull().default("live"),
    status: tournamentStatusEnum("status").notNull().default("setup"),
    /** Shape version of the JSON columns, for future upgrades. */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** Setup revision; bumped on every saved change and used as a CAS target. */
    revision: integer("revision").notNull().default(0),
    /** Six-character code judges type to join. Null until judge access opens. */
    joinCode: text("join_code"),
    settings: jsonb("settings").$type<TournamentSettings>().notNull(),
    scoringPolicy: jsonb("scoring_policy").$type<ScoringPolicyJson>().notNull(),
    /** Seed of the random draw, shown in the UI so a draw can be reproduced. */
    drawSeed: text("draw_seed"),
    demoTemplate: text("demo_template"),
    demoResetEveryMinutes: integer("demo_reset_every_minutes"),
    demoLastResetAt: timestampTz("demo_last_reset_at"),
    /** Per-visitor demo sandboxes are removed after this time. */
    demoExpiresAt: timestampTz("demo_expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tournaments_slug_unique").on(t.organisationId, t.slug),
    uniqueIndex("tournaments_join_code_unique")
      .on(sql`upper(${t.joinCode})`)
      .where(sql`${t.joinCode} is not null`),
    index("tournaments_demo_expiry")
      .on(t.demoExpiresAt)
      .where(sql`${t.demoExpiresAt} is not null`),
  ],
);

export const divisions = pgTable(
  "divisions",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Null while results are open; set when the organiser publishes them. */
    finalizedAt: timestampTz("finalized_at"),
    finalizedBy: text("finalized_by"),
    finalizedAtRevision: integer("finalized_at_revision"),
    /** Copy of the scoring policy at publish time; a later edit never changes a published result. */
    policySnapshot: jsonb("policy_snapshot").$type<ScoringPolicyJson>(),
    createdAt: createdAt(),
  },
  (t) => [unique("divisions_code_unique").on(t.tournamentId, t.code)],
);

export const rooms = pgTable(
  "rooms",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("rooms_name_unique").on(t.tournamentId, sql`lower(btrim(${t.name}))`)],
);

export const rounds = pgTable(
  "rounds",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    number: smallint("number").notNull(),
    format: roundFormatEnum("format").notNull(),
    sidesDecided: sidesDecidedEnum("sides_decided").notNull().default("in-advance"),
    status: roundStatusEnum("status").notNull().default("pending"),
    closedAt: timestampTz("closed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rounds_number_unique").on(t.tournamentId, t.number),
    check("rounds_number_positive", sql`${t.number} > 0`),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    divisionCode: text("division_code").notNull(),
    /** Short code used by the random draw, e.g. "O07". Unique per tournament. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    school: text("school").notNull(),
    /** Organiser-entered order for the seeded draw method. */
    seed: integer("seed"),
    status: teamStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "teams_division_fk",
      columns: [t.tournamentId, t.divisionCode],
      foreignColumns: [divisions.tournamentId, divisions.code],
    }).onUpdate("cascade"),
    unique("teams_code_unique").on(t.tournamentId, t.code),
    // The same school may not enter two teams with one name in one division.
    uniqueIndex("teams_school_name_unique").on(
      t.tournamentId,
      t.divisionCode,
      sql`lower(btrim(${t.school}))`,
      sql`lower(btrim(${t.name}))`,
    ),
  ],
);

export const speakers = pgTable(
  "speakers",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    /** 1 = first speaker (PM or LO), 2 = second speaker (GM or OM). */
    position: smallint("position").notNull(),
    name: text("name").notNull(),
    status: speakerStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("speakers_position_unique").on(t.teamId, t.position),
    check("speakers_position_1_or_2", sql`${t.position} in (1, 2)`),
  ],
);

export const judges = pgTable(
  "judges",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    name: text("name").notNull(),
    /** Short code printed on the judge's card; case-insensitive per tournament. */
    code: text("code").notNull(),
    /** sha256 of the secret in the QR / join link. Rotating it replaces the card. */
    joinTokenHash: text("join_token_hash").notNull().unique("judges_join_token_unique"),
    /** Bumping this revokes every session of the judge. */
    sessionEpoch: integer("session_epoch").notNull().default(0),
    /** Fixed room for the whole day when the panel mode is "fixed-room". */
    homeRoomId: uuid("home_room_id").references(() => rooms.id),
    status: judgeStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("judges_code_unique").on(t.tournamentId, sql`upper(${t.code})`)],
);

// ---------------------------------------------------------------------------
// Schedule (the draw)
// ---------------------------------------------------------------------------

export const debates = pgTable(
  "debates",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    divisionCode: text("division_code").notNull(),
    round: smallint("round").notNull(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    governmentTeamId: uuid("government_team_id")
      .notNull()
      .references(() => teams.id),
    oppositionTeamId: uuid("opposition_team_id")
      .notNull()
      .references(() => teams.id),
    motion: text("motion").notNull().default(""),
    /** In-room coin toss result. Not part of any assignment identity. */
    actualSides: jsonb("actual_sides").$type<ActualSides>(),
    /**
     * `least(team):greatest(team)`, maintained by Postgres, so "these two
     * teams already met" is a unique constraint rather than a query.
     */
    pairKey: text("pair_key").generatedAlwaysAs(
      sql`least("government_team_id", "opposition_team_id")::text || ':' || greatest("government_team_id", "opposition_team_id")::text`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "debates_division_fk",
      columns: [t.tournamentId, t.divisionCode],
      foreignColumns: [divisions.tournamentId, divisions.code],
    }).onUpdate("cascade"),
    foreignKey({
      name: "debates_round_fk",
      columns: [t.tournamentId, t.round],
      foreignColumns: [rounds.tournamentId, rounds.number],
    }),
    // A room hosts one debate per round, across both divisions.
    unique("debates_room_once").on(t.tournamentId, t.round, t.roomId),
    // Two teams meet at most once. This holds for the whole tournament, so a
    // final between two teams that already met in a preliminary round cannot
    // be stored; finals are decided outside the app (see docs/QUESTIONS-FOR-IAN.md).
    // If finals ever move in, add a `stage` column and make this a partial
    // unique index on preliminary debates, keeping the constraint name.
    unique("debates_pair_once").on(t.tournamentId, t.divisionCode, t.pairKey),
    // Lets child rows carry `round` with a composite FK that keeps it honest.
    unique("debates_id_round").on(t.id, t.round),
    check("debates_gov_opp_differ", sql`${t.governmentTeamId} <> ${t.oppositionTeamId}`),
  ],
);

/** One row per side of a debate; makes "a team debates once per round" declarative. */
export const debateTeams = pgTable(
  "debate_teams",
  {
    tournamentId: tournamentRef(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id),
    round: smallint("round").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    side: sideEnum("side").notNull(),
  },
  (t) => [
    primaryKey({ name: "debate_teams_pk", columns: [t.debateId, t.side] }),
    foreignKey({
      name: "debate_teams_debate_round_fk",
      columns: [t.debateId, t.round],
      foreignColumns: [debates.id, debates.round],
    }),
    unique("debate_teams_team_once").on(t.tournamentId, t.round, t.teamId),
  ],
);

/** One row per judge on a panel; makes "a judge sits once per round" declarative. */
export const debateJudges = pgTable(
  "debate_judges",
  {
    tournamentId: tournamentRef(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id),
    round: smallint("round").notNull(),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id),
    /** Seat 1 to 5, matching the five judge slots on the director's workbook. */
    seat: smallint("seat").notNull(),
  },
  (t) => [
    primaryKey({ name: "debate_judges_pk", columns: [t.debateId, t.judgeId] }),
    foreignKey({
      name: "debate_judges_debate_round_fk",
      columns: [t.debateId, t.round],
      foreignColumns: [debates.id, debates.round],
    }),
    unique("debate_judges_judge_once").on(t.tournamentId, t.round, t.judgeId),
    unique("debate_judges_seat_unique").on(t.debateId, t.seat),
    check("debate_judges_seat_range", sql`${t.seat} between 1 and 5`),
  ],
);

// ---------------------------------------------------------------------------
// Assignments and sheets
// ---------------------------------------------------------------------------

/**
 * One judge's slot on one debate. The id is a content hash of `identity`, so a
 * matchup change retires the row (`retired_at`) and creates a successor with a
 * new id. Display fields refresh in place without changing the id.
 */
export const assignments = pgTable(
  "assignments",
  {
    tournamentId: tournamentRef(),
    /** `asg_` + 20 hex characters. See `src/domain/schedule/assignmentId.ts`. */
    id: text("id").notNull(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id),
    identity: jsonb("identity").$type<AssignmentIdentity>().notNull(),
    identityHash: text("identity_hash").notNull(),
    display: jsonb("display").$type<AssignmentDisplay>().notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    createdAt: createdAt(),
    retiredAt: timestampTz("retired_at"),
    retiredReason: text("retired_reason"),
    /** The assignment that replaced this one, when the draw changed. */
    successorId: text("successor_id"),
  },
  (t) => [
    primaryKey({ name: "assignments_pk", columns: [t.tournamentId, t.id] }),
    // Only one live assignment per (debate, judge) slot.
    uniqueIndex("assignments_live_slot")
      .on(t.debateId, t.judgeId)
      .where(sql`${t.retiredAt} is null`),
    index("assignments_judge_live")
      .on(t.tournamentId, t.judgeId)
      .where(sql`${t.retiredAt} is null`),
    index("assignments_debate").on(t.debateId),
  ],
);

/** Append-only history of a sheet. Every write, by anyone, is a new version. */
export const sheetVersions = pgTable(
  "sheet_versions",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    assignmentId: text("assignment_id").notNull(),
    version: integer("version").notNull(),
    scores: jsonb("scores").$type<SheetScores>().notNull(),
    /** True when the room's coin toss put the drawn Opposition on Government. */
    sideFlipped: boolean("side_flipped").notNull().default(false),
    /** teamId -> true when the two teammates swapped speaking roles. */
    roleSwaps: jsonb("role_swaps").$type<Record<string, boolean>>().notNull().default({}),
    source: sheetSourceEnum("source").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    /** Mandatory for organiser corrections and resolutions (enforced in the service). */
    reason: text("reason"),
    /** The judge's request id, for tracing a version back to its submission. */
    requestKey: text("request_key"),
    receivedAt: timestampTz("received_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "sheet_versions_assignment_fk",
      columns: [t.tournamentId, t.assignmentId],
      foreignColumns: [assignments.tournamentId, assignments.id],
    }),
    unique("sheet_versions_version_unique").on(t.tournamentId, t.assignmentId, t.version),
  ],
);

/** The current version pointer of a sheet; the compare-and-set target. */
export const sheets = pgTable(
  "sheets",
  {
    tournamentId: tournamentRef(),
    assignmentId: text("assignment_id").notNull(),
    version: integer("version").notNull(),
    currentVersionId: uuid("current_version_id")
      .notNull()
      .references(() => sheetVersions.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sheets_pk", columns: [t.tournamentId, t.assignmentId] }),
    foreignKey({
      name: "sheets_assignment_fk",
      columns: [t.tournamentId, t.assignmentId],
      foreignColumns: [assignments.tournamentId, assignments.id],
    }),
  ],
);

/**
 * Idempotency receipts. A judge retry with the same request id and fingerprint
 * gets the stored response back; a reused id with a different fingerprint is
 * refused. `assignment_id` has no foreign key on purpose: the receipt of a
 * request for an unknown or retired assignment must still be stored.
 */
export const submissions = pgTable(
  "submissions",
  {
    tournamentId: tournamentRef(),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id),
    requestId: text("request_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    /** sha256 of the canonical payload. */
    fingerprint: text("fingerprint").notNull(),
    state: submissionStateEnum("state").notNull().default("pending"),
    httpStatus: smallint("http_status"),
    response: jsonb("response").$type<StoredResponse>(),
    createdAt: createdAt(),
    completedAt: timestampTz("completed_at"),
  },
  (t) => [
    primaryKey({ name: "submissions_pk", columns: [t.tournamentId, t.judgeId, t.requestId] }),
    index("submissions_assignment").on(t.tournamentId, t.assignmentId),
  ],
);

/** A sheet that arrived in two versions, waiting for an organiser. */
export const conflicts = pgTable(
  "conflicts",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    assignmentId: text("assignment_id").notNull(),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id),
    requestId: text("request_id").notNull(),
    kind: conflictKindEnum("kind").notNull(),
    /** The payload the judge sent. */
    incoming: jsonb("incoming").$type<SheetPayload>().notNull(),
    /** The version the judge edited from. */
    baseVersion: integer("base_version").notNull(),
    /** The sheet's version when the conflict was recorded. */
    currentVersion: integer("current_version").notNull(),
    status: conflictStatusEnum("status").notNull().default("open"),
    resolution: jsonb("resolution").$type<ConflictResolution>(),
    resolvedAt: timestampTz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conflicts_assignment_fk",
      columns: [t.tournamentId, t.assignmentId],
      foreignColumns: [assignments.tournamentId, assignments.id],
    }),
    uniqueIndex("conflicts_one_open")
      .on(t.tournamentId, t.judgeId, t.requestId)
      .where(sql`${t.status} = 'open'`),
    index("conflicts_open_by_tournament")
      .on(t.tournamentId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/** An organiser's decision to publish results without one judge's sheet. */
export const sheetWaivers = pgTable(
  "sheet_waivers",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    assignmentId: text("assignment_id").notNull(),
    reason: reasonRequired(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    revokedAt: timestampTz("revoked_at"),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    foreignKey({
      name: "sheet_waivers_assignment_fk",
      columns: [t.tournamentId, t.assignmentId],
      foreignColumns: [assignments.tournamentId, assignments.id],
    }),
    uniqueIndex("sheet_waivers_live")
      .on(t.tournamentId, t.assignmentId)
      .where(sql`${t.revokedAt} is null`),
    check("sheet_waivers_reason_present", sql`length(btrim(${t.reason})) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Results governance
// ---------------------------------------------------------------------------

/**
 * Organiser overrides applied after the outlier policy. Which target columns
 * are set depends on `kind`; the service validates the combination. Revoking
 * is a timestamp, never a delete.
 */
export const scoreOverrides = pgTable(
  "score_overrides",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    divisionCode: text("division_code").notNull(),
    speakerId: uuid("speaker_id").references(() => speakers.id),
    teamId: uuid("team_id").references(() => teams.id),
    round: smallint("round"),
    assignmentId: text("assignment_id"),
    kind: overrideKindEnum("kind").notNull(),
    reason: reasonRequired(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    revokedAt: timestampTz("revoked_at"),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    foreignKey({
      name: "score_overrides_division_fk",
      columns: [t.tournamentId, t.divisionCode],
      foreignColumns: [divisions.tournamentId, divisions.code],
    }).onUpdate("cascade"),
    foreignKey({
      name: "score_overrides_assignment_fk",
      columns: [t.tournamentId, t.assignmentId],
      foreignColumns: [assignments.tournamentId, assignments.id],
    }),
    index("score_overrides_division_live")
      .on(t.tournamentId, t.divisionCode)
      .where(sql`${t.revokedAt} is null`),
    check("score_overrides_reason_present", sql`length(btrim(${t.reason})) > 0`),
  ],
);

export interface JudgeDeviceSheetStatus {
  assignmentId: string;
  state: "draft" | "queued" | "sending" | "conflict" | "attention" | "received";
  filled?: number;
  updatedAt?: string;
}

/** Heartbeat from a judge's phone, so the live board can say "queued on phone, last seen 2 min ago". */
export const judgeDevices = pgTable(
  "judge_devices",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id),
    /** Random id the PWA generates once per install. */
    deviceId: text("device_id").notNull(),
    lastSeenAt: timestampTz("last_seen_at").notNull().defaultNow(),
    queuedCount: integer("queued_count").notNull().default(0),
    queuedAssignmentIds: jsonb("queued_assignment_ids").$type<string[]>().notNull().default([]),
    statuses: jsonb("statuses").$type<JudgeDeviceSheetStatus[]>().notNull().default([]),
    appVersion: text("app_version"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [unique("judge_devices_unique").on(t.tournamentId, t.judgeId, t.deviceId)],
);

/** An organiser marking a computed checklist step as done or skipped, with a reason. */
export const checklistOverrides = pgTable(
  "checklist_overrides",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    stepKey: text("step_key").notNull(),
    state: checklistStateEnum("state").notNull(),
    reason: reasonRequired(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    revokedAt: timestampTz("revoked_at"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    uniqueIndex("checklist_overrides_live")
      .on(t.tournamentId, t.stepKey)
      .where(sql`${t.revokedAt} is null`),
    check("checklist_overrides_reason_present", sql`length(btrim(${t.reason})) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Audit and history (append-only)
// ---------------------------------------------------------------------------

/** Audit actions that must carry a reason. Enforced by a CHECK below. */
export const AUDIT_ACTIONS_REQUIRING_REASON = [
  "sheet_manual_entry",
  "sheet_corrected",
  "conflict_resolved",
  "division_unlocked",
  "override_created",
  "override_revoked",
  "backup_restored",
  "assignment_retired_with_orphan",
  "sheet_waived",
  "checklist_overridden",
] as const;

/**
 * Every change an organiser, judge or the system makes. Rows are never
 * updated or deleted: migration 0002 adds a trigger that raises on both.
 * `tournament_id` has no foreign key so the trail outlives its tournament.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tournamentId: uuid("tournament_id"),
    at: timestampTz("at").notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    /** e.g. "sheet_submitted", "draw_generated", "division_finalized". */
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    divisionCode: text("division_code"),
    assignmentId: text("assignment_id"),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    /** microdiff output for setup changes; small enough to show in the UI. */
    diff: jsonb("diff"),
    requestId: text("request_id"),
  },
  (t) => [
    index("audit_log_tournament_at").on(t.tournamentId, t.at.desc()),
    check(
      "audit_log_reason_required",
      sql`${t.action} not in (${sql.raw(
        AUDIT_ACTIONS_REQUIRING_REASON.map((action) => `'${action}'`).join(", "),
      )}) or length(btrim(coalesce(${t.reason}, ''))) > 0`,
    ),
  ],
);

/** Full setup snapshot per revision: the source of "the draw changed after round 1" diffs. */
export const setupRevisions = pgTable(
  "setup_revisions",
  {
    tournamentId: tournamentRef(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<Schedule>().notNull(),
    author: text("author"),
    at: timestampTz("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "setup_revisions_pk", columns: [t.tournamentId, t.revision] })],
);

/** Whole-tournament backups taken before risky operations and on request. */
export const tournamentSnapshots = pgTable(
  "tournament_snapshots",
  {
    id: uuidPk(),
    tournamentId: tournamentRef(),
    kind: snapshotKindEnum("kind").notNull(),
    label: text("label"),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    byteSize: integer("byte_size"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [index("tournament_snapshots_tournament_at").on(t.tournamentId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Row types. `XRow` is what a select returns; `NewXRow` is what an insert takes.
// ---------------------------------------------------------------------------

export type OrganisationRow = typeof organisations.$inferSelect;
export type NewOrganisationRow = typeof organisations.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;
export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type RateLimitRow = typeof rateLimits.$inferSelect;
export type NewRateLimitRow = typeof rateLimits.$inferInsert;
export type TournamentRow = typeof tournaments.$inferSelect;
export type NewTournamentRow = typeof tournaments.$inferInsert;
export type DivisionRow = typeof divisions.$inferSelect;
export type NewDivisionRow = typeof divisions.$inferInsert;
export type RoomRow = typeof rooms.$inferSelect;
export type NewRoomRow = typeof rooms.$inferInsert;
export type RoundRow = typeof rounds.$inferSelect;
export type NewRoundRow = typeof rounds.$inferInsert;
export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;
export type SpeakerRow = typeof speakers.$inferSelect;
export type NewSpeakerRow = typeof speakers.$inferInsert;
export type JudgeRow = typeof judges.$inferSelect;
export type NewJudgeRow = typeof judges.$inferInsert;
export type DebateRow = typeof debates.$inferSelect;
export type NewDebateRow = typeof debates.$inferInsert;
export type DebateTeamRow = typeof debateTeams.$inferSelect;
export type NewDebateTeamRow = typeof debateTeams.$inferInsert;
export type DebateJudgeRow = typeof debateJudges.$inferSelect;
export type NewDebateJudgeRow = typeof debateJudges.$inferInsert;
export type AssignmentRow = typeof assignments.$inferSelect;
export type NewAssignmentRow = typeof assignments.$inferInsert;
export type SheetRow = typeof sheets.$inferSelect;
export type NewSheetRow = typeof sheets.$inferInsert;
export type SheetVersionRow = typeof sheetVersions.$inferSelect;
export type NewSheetVersionRow = typeof sheetVersions.$inferInsert;
export type SubmissionRow = typeof submissions.$inferSelect;
export type NewSubmissionRow = typeof submissions.$inferInsert;
export type ConflictRow = typeof conflicts.$inferSelect;
export type NewConflictRow = typeof conflicts.$inferInsert;
export type SheetWaiverRow = typeof sheetWaivers.$inferSelect;
export type NewSheetWaiverRow = typeof sheetWaivers.$inferInsert;
export type ScoreOverrideRow = typeof scoreOverrides.$inferSelect;
export type NewScoreOverrideRow = typeof scoreOverrides.$inferInsert;
export type JudgeDeviceRow = typeof judgeDevices.$inferSelect;
export type NewJudgeDeviceRow = typeof judgeDevices.$inferInsert;
export type ChecklistOverrideRow = typeof checklistOverrides.$inferSelect;
export type NewChecklistOverrideRow = typeof checklistOverrides.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type SetupRevisionRow = typeof setupRevisions.$inferSelect;
export type NewSetupRevisionRow = typeof setupRevisions.$inferInsert;
export type TournamentSnapshotRow = typeof tournamentSnapshots.$inferSelect;
export type NewTournamentSnapshotRow = typeof tournamentSnapshots.$inferInsert;
