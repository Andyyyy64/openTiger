import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// 環境変数からDB接続URLを取得
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://sebastian-code:sebastian-code@localhost:5432/sebastian-code";

// PostgreSQLクライアント
const client = postgres(connectionString);

// Drizzle ORMインスタンス
export const db = drizzle(client, { schema });

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

// 型エクスポート
export type Database = typeof db;
