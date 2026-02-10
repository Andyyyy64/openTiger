ALTER TABLE "config" ADD COLUMN "llm_executor" text DEFAULT 'opencode' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "claude_code_permission_mode" text DEFAULT 'bypassPermissions' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "claude_code_max_turns" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "claude_code_allowed_tools" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "claude_code_disallowed_tools" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "claude_code_append_system_prompt" text DEFAULT '' NOT NULL;
