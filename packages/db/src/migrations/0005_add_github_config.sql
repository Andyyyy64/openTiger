ALTER TABLE "config" ADD COLUMN "github_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "github_owner" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "github_repo" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config" ADD COLUMN "repo_url" text DEFAULT '' NOT NULL;
