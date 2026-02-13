ALTER TABLE "config" ADD COLUMN "codex_model" text DEFAULT 'gpt-5.3-codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "codex_max_retries" text DEFAULT '3' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "codex_retry_delay_ms" text DEFAULT '5000' NOT NULL;