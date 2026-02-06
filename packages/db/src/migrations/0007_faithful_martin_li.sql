ALTER TABLE "config" ADD COLUMN "repo_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "github_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "github_owner" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "github_repo" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "judgement_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "block_reason" text;