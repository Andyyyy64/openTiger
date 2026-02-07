ALTER TABLE "config" ADD COLUMN "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL;