CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"max_concurrent_workers" text DEFAULT '10' NOT NULL,
	"daily_token_limit" text DEFAULT '50000000' NOT NULL,
	"hourly_token_limit" text DEFAULT '5000000' NOT NULL,
	"task_token_limit" text DEFAULT '1000000' NOT NULL,
	"dispatcher_enabled" text DEFAULT 'true' NOT NULL,
	"judge_enabled" text DEFAULT 'true' NOT NULL,
	"cycle_manager_enabled" text DEFAULT 'true' NOT NULL,
	"worker_count" text DEFAULT '1' NOT NULL,
	"tester_count" text DEFAULT '1' NOT NULL,
	"docser_count" text DEFAULT '1' NOT NULL,
	"repo_mode" text DEFAULT 'git' NOT NULL,
	"local_repo_path" text DEFAULT '' NOT NULL,
	"local_worktree_root" text DEFAULT '' NOT NULL,
	"judge_mode" text DEFAULT 'auto' NOT NULL,
	"local_policy_max_lines" text DEFAULT '5000' NOT NULL,
	"local_policy_max_files" text DEFAULT '100' NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"opencode_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL,
	"planner_model" text DEFAULT 'google/gemini-3-pro-preview' NOT NULL,
	"judge_model" text DEFAULT 'google/gemini-3-pro-preview' NOT NULL,
	"worker_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL,
	"planner_use_remote" text DEFAULT 'false' NOT NULL,
	"planner_repo_url" text DEFAULT '' NOT NULL,
	"auto_replan" text DEFAULT 'true' NOT NULL,
	"replan_requirement_path" text DEFAULT 'requirement.md' NOT NULL,
	"replan_interval_ms" text DEFAULT '60000' NOT NULL,
	"replan_command" text DEFAULT 'pnpm --filter @openTiger/planner start' NOT NULL,
	"replan_workdir" text DEFAULT '' NOT NULL,
	"replan_repo_url" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_area" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "touches" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;