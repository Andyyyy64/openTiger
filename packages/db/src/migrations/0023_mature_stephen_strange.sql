ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_no_change_recovery_attempts" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_policy_recovery_attempts" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_recovery_attempts" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "blocked_needs_rework_in_place_retry_limit" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_llm_executor" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "tester_llm_executor" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "docser_llm_executor" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_llm_executor" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_llm_executor" text DEFAULT 'inherit' NOT NULL;-->statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_setup_in_process_recovery" text DEFAULT 'true' NOT NULL;-->statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_llm_inline_recovery" text DEFAULT 'true' NOT NULL;-->statement-breakpoint
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_llm_inline_recovery_attempts" text DEFAULT '3' NOT NULL;
