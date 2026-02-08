ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "block_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "judgement_version" integer DEFAULT 0 NOT NULL;
