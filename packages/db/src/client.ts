import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// 環境変数からDB接続URLを取得
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://opentiger:opentiger@localhost:5432/opentiger";

// PostgreSQLクライアント
// max: 接続プールサイズ（各プロセスでこの数まで接続を使用）
// api/worker/dispatcher/judge/planner/cycle-manager など複数プロセスが同時接続するため
// プロセスあたりの接続数を抑えて max_connections 枯渇を防ぐ
const client = postgres(connectionString, { max: 3 });

// Drizzle ORMインスタンス
export const db = drizzle(client, { schema });
export { sql };

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

// 型エクスポート
export type Database = typeof db;
