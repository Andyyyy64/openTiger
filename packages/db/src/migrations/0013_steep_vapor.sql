ALTER TABLE "config" ALTER COLUMN "max_concurrent_workers" SET DEFAULT '-1';--> statement-breakpoint
ALTER TABLE "config" ALTER COLUMN "daily_token_limit" SET DEFAULT '-1';--> statement-breakpoint
ALTER TABLE "config" ALTER COLUMN "hourly_token_limit" SET DEFAULT '-1';--> statement-breakpoint
ALTER TABLE "config" ALTER COLUMN "task_token_limit" SET DEFAULT '-1';--> statement-breakpoint
ALTER TABLE "config" ALTER COLUMN "planner_use_remote" SET DEFAULT 'true';--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "opencode_small_model" text DEFAULT 'google/gemini-2.5-flash' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "tester_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "docser_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL;