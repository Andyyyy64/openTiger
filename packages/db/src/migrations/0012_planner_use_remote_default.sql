ALTER TABLE "config" ALTER COLUMN "planner_use_remote" SET DEFAULT 'true';--> statement-breakpoint
UPDATE "config"
SET "planner_use_remote" = 'true'
WHERE "planner_use_remote" = 'false'
  AND "repo_mode" = 'git';
