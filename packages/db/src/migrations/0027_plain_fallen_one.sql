ALTER TABLE "config"
ADD COLUMN IF NOT EXISTS "enabled_plugins" text DEFAULT '' NOT NULL;
