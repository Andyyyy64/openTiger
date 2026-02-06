ALTER TABLE "tasks" ADD COLUMN "block_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "judgement_version" integer DEFAULT 0 NOT NULL;
