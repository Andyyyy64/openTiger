CREATE TABLE "plugin_migration_history" (
	"plugin_id" text NOT NULL,
	"migration_name" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_migration_history_plugin_id_migration_name_pk" PRIMARY KEY("plugin_id","migration_name")
);
