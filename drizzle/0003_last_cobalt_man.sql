ALTER TABLE "judge_devices" ADD COLUMN "statuses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "closed_at" timestamp with time zone;