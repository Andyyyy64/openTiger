ALTER TABLE "config" ADD COLUMN "anthropic_api_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "gemini_api_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "openai_api_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "xai_api_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "deepseek_api_key" text DEFAULT '' NOT NULL;