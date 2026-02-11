import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Get DB connection URL from env
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://opentiger:opentiger@localhost:5432/opentiger";

// PostgreSQL client
// max: pool size (each process uses up to this many connections)
// Multiple processes (api/worker/dispatcher/judge/planner/cycle-manager) connect concurrently
// Limit connections per process to avoid max_connections exhaustion
// Suppress NOTICE (frequent during startup self-heal queries) in normal operation
const shouldLogPostgresNotice = process.env.LOG_POSTGRES_NOTICE === "true";
const client = postgres(connectionString, {
  max: 3,
  onnotice: shouldLogPostgresNotice
    ? (notice) => console.warn("[Postgres NOTICE]", notice)
    : () => {},
});

// Drizzle ORM instance
export const db = drizzle(client, { schema });
export { sql };

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

// Type exports
export type Database = typeof db;
