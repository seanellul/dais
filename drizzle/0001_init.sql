CREATE TYPE "public"."actor_type" AS ENUM('organiser', 'judge', 'system', 'demo');--> statement-breakpoint
CREATE TYPE "public"."checklist_state" AS ENUM('done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."conflict_kind" AS ENUM('version', 'comments_only');--> statement-breakpoint
CREATE TYPE "public"."conflict_status" AS ENUM('open', 'resolved', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."judge_status" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'organiser');--> statement-breakpoint
CREATE TYPE "public"."override_kind" AS ENUM('force_include', 'force_exclude', 'keep_all_for_debater', 'exclude_debater', 'waive_missing_sheet', 'rank_single_speaker_team');--> statement-breakpoint
CREATE TYPE "public"."round_format" AS ENUM('prepared', 'impromptu');--> statement-breakpoint
CREATE TYPE "public"."round_status" AS ENUM('pending', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('organiser', 'judge', 'demo');--> statement-breakpoint
CREATE TYPE "public"."sheet_source" AS ENUM('judge', 'judge_handoff', 'organiser_paper', 'organiser_correction', 'organiser_resolution', 'simulated', 'import');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('government', 'opposition');--> statement-breakpoint
CREATE TYPE "public"."sides_decided" AS ENUM('in-advance', 'in-room');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('manual', 'pre_restore', 'pre_finalize', 'pre_unlock', 'pre_draw_save', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."speaker_status" AS ENUM('active', 'absent');--> statement-breakpoint
CREATE TYPE "public"."submission_state" AS ENUM('pending', 'done');--> statement-breakpoint
CREATE TYPE "public"."team_status" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."tournament_kind" AS ENUM('live', 'sandbox', 'demo');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('setup', 'running', 'complete', 'archived');--> statement-breakpoint
CREATE TABLE "assignments" (
	"tournament_id" uuid NOT NULL,
	"id" text NOT NULL,
	"debate_id" uuid NOT NULL,
	"judge_id" uuid NOT NULL,
	"identity" jsonb NOT NULL,
	"identity_hash" text NOT NULL,
	"display" jsonb NOT NULL,
	"schedule_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"successor_id" text,
	CONSTRAINT "assignments_pk" PRIMARY KEY("tournament_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tournament_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"division_code" text,
	"assignment_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"diff" jsonb,
	"request_id" text,
	CONSTRAINT "audit_log_reason_required" CHECK ("audit_log"."action" not in ('sheet_manual_entry', 'sheet_corrected', 'conflict_resolved', 'division_unlocked', 'override_created', 'override_revoked', 'backup_restored', 'assignment_retired_with_orphan', 'sheet_waived', 'checklist_overridden') or length(btrim(coalesce("audit_log"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "checklist_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"state" "checklist_state" NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "checklist_overrides_reason_present" CHECK (length(btrim("checklist_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "conflicts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"assignment_id" text NOT NULL,
	"judge_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"kind" "conflict_kind" NOT NULL,
	"incoming" jsonb NOT NULL,
	"base_version" integer NOT NULL,
	"current_version" integer NOT NULL,
	"status" "conflict_status" DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_judges" (
	"tournament_id" uuid NOT NULL,
	"debate_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"judge_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	CONSTRAINT "debate_judges_pk" PRIMARY KEY("debate_id","judge_id"),
	CONSTRAINT "debate_judges_judge_once" UNIQUE("tournament_id","round","judge_id"),
	CONSTRAINT "debate_judges_seat_unique" UNIQUE("debate_id","seat"),
	CONSTRAINT "debate_judges_seat_range" CHECK ("debate_judges"."seat" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "debate_teams" (
	"tournament_id" uuid NOT NULL,
	"debate_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"team_id" uuid NOT NULL,
	"side" "side" NOT NULL,
	CONSTRAINT "debate_teams_pk" PRIMARY KEY("debate_id","side"),
	CONSTRAINT "debate_teams_team_once" UNIQUE("tournament_id","round","team_id")
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"division_code" text NOT NULL,
	"round" smallint NOT NULL,
	"room_id" uuid NOT NULL,
	"government_team_id" uuid NOT NULL,
	"opposition_team_id" uuid NOT NULL,
	"motion" text DEFAULT '' NOT NULL,
	"actual_sides" jsonb,
	"pair_key" text GENERATED ALWAYS AS (least("government_team_id", "opposition_team_id")::text || ':' || greatest("government_team_id", "opposition_team_id")::text) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debates_room_once" UNIQUE("tournament_id","round","room_id"),
	CONSTRAINT "debates_pair_once" UNIQUE("tournament_id","division_code","pair_key"),
	CONSTRAINT "debates_id_round" UNIQUE("id","round"),
	CONSTRAINT "debates_gov_opp_differ" CHECK ("debates"."government_team_id" <> "debates"."opposition_team_id")
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	"finalized_at_revision" integer,
	"policy_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "divisions_code_unique" UNIQUE("tournament_id","code")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" DEFAULT 'organiser' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "judge_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"judge_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_count" integer DEFAULT 0 NOT NULL,
	"queued_assignment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"app_version" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_devices_unique" UNIQUE("tournament_id","judge_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "judges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"join_token_hash" text NOT NULL,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"home_room_id" uuid,
	"status" "judge_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judges_join_token_unique" UNIQUE("join_token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'organiser' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pk" PRIMARY KEY("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"number" smallint NOT NULL,
	"format" "round_format" NOT NULL,
	"sides_decided" "sides_decided" DEFAULT 'in-advance' NOT NULL,
	"status" "round_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounds_number_unique" UNIQUE("tournament_id","number"),
	CONSTRAINT "rounds_number_positive" CHECK ("rounds"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "score_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"division_code" text NOT NULL,
	"speaker_id" uuid,
	"team_id" uuid,
	"round" smallint,
	"assignment_id" text,
	"kind" "override_kind" NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	CONSTRAINT "score_overrides_reason_present" CHECK (length(btrim("score_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"kind" "session_kind" NOT NULL,
	"user_id" uuid,
	"judge_id" uuid,
	"tournament_id" uuid,
	"organisation_id" uuid,
	"epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"user_agent" text,
	"ip_hash" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_kind_shape" CHECK (("sessions"."kind" = 'organiser' and "sessions"."user_id" is not null)
        or ("sessions"."kind" = 'judge' and "sessions"."judge_id" is not null and "sessions"."tournament_id" is not null)
        or ("sessions"."kind" = 'demo' and "sessions"."tournament_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "setup_revisions" (
	"tournament_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"author" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_revisions_pk" PRIMARY KEY("tournament_id","revision")
);
--> statement-breakpoint
CREATE TABLE "sheet_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"assignment_id" text NOT NULL,
	"version" integer NOT NULL,
	"scores" jsonb NOT NULL,
	"side_flipped" boolean DEFAULT false NOT NULL,
	"role_swaps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "sheet_source" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"reason" text,
	"request_key" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_versions_version_unique" UNIQUE("tournament_id","assignment_id","version")
);
--> statement-breakpoint
CREATE TABLE "sheet_waivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"assignment_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	CONSTRAINT "sheet_waivers_reason_present" CHECK (length(btrim("sheet_waivers"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sheets" (
	"tournament_id" uuid NOT NULL,
	"assignment_id" text NOT NULL,
	"version" integer NOT NULL,
	"current_version_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sheets_pk" PRIMARY KEY("tournament_id","assignment_id")
);
--> statement-breakpoint
CREATE TABLE "speakers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"status" "speaker_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speakers_position_unique" UNIQUE("team_id","position"),
	CONSTRAINT "speakers_position_1_or_2" CHECK ("speakers"."position" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"tournament_id" uuid NOT NULL,
	"judge_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" "submission_state" DEFAULT 'pending' NOT NULL,
	"http_status" smallint,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "submissions_pk" PRIMARY KEY("tournament_id","judge_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"division_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"school" text NOT NULL,
	"seed" integer,
	"status" "team_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_code_unique" UNIQUE("tournament_id","code")
);
--> statement-breakpoint
CREATE TABLE "tournament_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"kind" "snapshot_kind" NOT NULL,
	"label" text,
	"body" jsonb NOT NULL,
	"byte_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "tournament_kind" DEFAULT 'live' NOT NULL,
	"status" "tournament_status" DEFAULT 'setup' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"join_code" text,
	"settings" jsonb NOT NULL,
	"scoring_policy" jsonb NOT NULL,
	"draw_seed" text,
	"demo_template" text,
	"demo_reset_every_minutes" integer,
	"demo_last_reset_at" timestamp with time zone,
	"demo_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_slug_unique" UNIQUE("organisation_id","slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_overrides" ADD CONSTRAINT "checklist_overrides_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_assignment_fk" FOREIGN KEY ("tournament_id","assignment_id") REFERENCES "public"."assignments"("tournament_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_judges" ADD CONSTRAINT "debate_judges_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_judges" ADD CONSTRAINT "debate_judges_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_judges" ADD CONSTRAINT "debate_judges_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_judges" ADD CONSTRAINT "debate_judges_debate_round_fk" FOREIGN KEY ("debate_id","round") REFERENCES "public"."debates"("id","round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_teams" ADD CONSTRAINT "debate_teams_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_teams" ADD CONSTRAINT "debate_teams_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_teams" ADD CONSTRAINT "debate_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_teams" ADD CONSTRAINT "debate_teams_debate_round_fk" FOREIGN KEY ("debate_id","round") REFERENCES "public"."debates"("id","round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_government_team_id_teams_id_fk" FOREIGN KEY ("government_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_opposition_team_id_teams_id_fk" FOREIGN KEY ("opposition_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_division_fk" FOREIGN KEY ("tournament_id","division_code") REFERENCES "public"."divisions"("tournament_id","code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_round_fk" FOREIGN KEY ("tournament_id","round") REFERENCES "public"."rounds"("tournament_id","number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_devices" ADD CONSTRAINT "judge_devices_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_devices" ADD CONSTRAINT "judge_devices_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judges" ADD CONSTRAINT "judges_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judges" ADD CONSTRAINT "judges_home_room_id_rooms_id_fk" FOREIGN KEY ("home_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_overrides" ADD CONSTRAINT "score_overrides_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_overrides" ADD CONSTRAINT "score_overrides_speaker_id_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."speakers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_overrides" ADD CONSTRAINT "score_overrides_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_overrides" ADD CONSTRAINT "score_overrides_division_fk" FOREIGN KEY ("tournament_id","division_code") REFERENCES "public"."divisions"("tournament_id","code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "score_overrides" ADD CONSTRAINT "score_overrides_assignment_fk" FOREIGN KEY ("tournament_id","assignment_id") REFERENCES "public"."assignments"("tournament_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_revisions" ADD CONSTRAINT "setup_revisions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_versions" ADD CONSTRAINT "sheet_versions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_versions" ADD CONSTRAINT "sheet_versions_assignment_fk" FOREIGN KEY ("tournament_id","assignment_id") REFERENCES "public"."assignments"("tournament_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_waivers" ADD CONSTRAINT "sheet_waivers_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_waivers" ADD CONSTRAINT "sheet_waivers_assignment_fk" FOREIGN KEY ("tournament_id","assignment_id") REFERENCES "public"."assignments"("tournament_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheets" ADD CONSTRAINT "sheets_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheets" ADD CONSTRAINT "sheets_current_version_id_sheet_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."sheet_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheets" ADD CONSTRAINT "sheets_assignment_fk" FOREIGN KEY ("tournament_id","assignment_id") REFERENCES "public"."assignments"("tournament_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_division_fk" FOREIGN KEY ("tournament_id","division_code") REFERENCES "public"."divisions"("tournament_id","code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tournament_snapshots" ADD CONSTRAINT "tournament_snapshots_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_live_slot" ON "assignments" USING btree ("debate_id","judge_id") WHERE "assignments"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "assignments_judge_live" ON "assignments" USING btree ("tournament_id","judge_id") WHERE "assignments"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "assignments_debate" ON "assignments" USING btree ("debate_id");--> statement-breakpoint
CREATE INDEX "audit_log_tournament_at" ON "audit_log" USING btree ("tournament_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_overrides_live" ON "checklist_overrides" USING btree ("tournament_id","step_key") WHERE "checklist_overrides"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conflicts_one_open" ON "conflicts" USING btree ("tournament_id","judge_id","request_id") WHERE "conflicts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "conflicts_open_by_tournament" ON "conflicts" USING btree ("tournament_id") WHERE "conflicts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "invites_organisation" ON "invites" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "judges_code_unique" ON "judges" USING btree ("tournament_id",upper("code"));--> statement-breakpoint
CREATE INDEX "memberships_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_name_unique" ON "rooms" USING btree ("tournament_id",lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "score_overrides_division_live" ON "score_overrides" USING btree ("tournament_id","division_code") WHERE "score_overrides"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_judge_live" ON "sessions" USING btree ("judge_id") WHERE "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_waivers_live" ON "sheet_waivers" USING btree ("tournament_id","assignment_id") WHERE "sheet_waivers"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "submissions_assignment" ON "submissions" USING btree ("tournament_id","assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_school_name_unique" ON "teams" USING btree ("tournament_id","division_code",lower(btrim("school")),lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "tournament_snapshots_tournament_at" ON "tournament_snapshots" USING btree ("tournament_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_join_code_unique" ON "tournaments" USING btree (upper("join_code")) WHERE "tournaments"."join_code" is not null;--> statement-breakpoint
CREATE INDEX "tournaments_demo_expiry" ON "tournaments" USING btree ("demo_expires_at") WHERE "tournaments"."demo_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));