ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "repo_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "github_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "github_owner" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "github_repo" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "judgement_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "block_reason" text;
