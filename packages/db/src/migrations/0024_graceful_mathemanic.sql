CREATE TABLE "pr_merge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_number" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"claim_owner" text,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "dispatch_conflict_lane_max_slots" text DEFAULT '2' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "dispatch_feature_lane_min_slots" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "dispatch_docser_lane_max_slots" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "judge_merge_queue_max_attempts" text DEFAULT '3' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "judge_merge_queue_retry_delay_ms" text DEFAULT '30000' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "judge_merge_queue_claim_ttl_ms" text DEFAULT '120000' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lane" text DEFAULT 'feature' NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "lane" = 'research' WHERE "kind" = 'research';--> statement-breakpoint
UPDATE "tasks"
SET "lane" = 'docser'
WHERE "role" = 'docser' OR "title" LIKE 'Documentation update:%';--> statement-breakpoint
UPDATE "tasks"
SET "lane" = 'conflict_recovery'
WHERE
  "title" LIKE '%[AutoFix] PR #%' OR
  "title" LIKE '%[AutoFix-Conflict] PR #%' OR
  "title" LIKE '%[Recreate-From-Main] PR #%';--> statement-breakpoint
ALTER TABLE "pr_merge_queue" ADD CONSTRAINT "pr_merge_queue_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_merge_queue" ADD CONSTRAINT "pr_merge_queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_merge_queue_active_pr_unq"
ON "pr_merge_queue" ("pr_number")
WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "pr_merge_queue_task_run_unq" ON "pr_merge_queue" ("task_id", "run_id");--> statement-breakpoint
CREATE INDEX "pr_merge_queue_dequeue_idx"
ON "pr_merge_queue" ("status", "next_attempt_at", "priority", "created_at");--> statement-breakpoint
CREATE INDEX "pr_merge_queue_processing_expiry_idx"
ON "pr_merge_queue" ("status", "claim_expires_at");--> statement-breakpoint
CREATE INDEX "tasks_lane_dispatch_idx"
ON "tasks" ("status", "lane", "priority", "created_at");