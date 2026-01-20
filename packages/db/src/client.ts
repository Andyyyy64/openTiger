import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// 環境変数からDB接続URLを取得
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://h1ve:h1ve@localhost:5432/h1ve";

// PostgreSQLクライアント
const client = postgres(connectionString);

// Drizzle ORMインスタンス
export const db = drizzle(client, { schema });

// 型エクスポート
export type Database = typeof db;
