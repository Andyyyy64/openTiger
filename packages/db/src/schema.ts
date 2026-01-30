import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

// タスクテーブル: 作業単位を管理
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  goal: text("goal").notNull(), // 完了条件
  context: jsonb("context"), // 関連情報（files, specs, notes）
  allowedPaths: text("allowed_paths").array().notNull(), // 変更許可パス
  commands: text("commands").array().notNull(), // 検証コマンド
  priority: integer("priority").default(0).notNull(),
  riskLevel: text("risk_level").default("low").notNull(), // low/medium/high
  role: text("role").default("worker").notNull(), // worker/tester
  status: text("status").default("queued").notNull(), // queued/running/done/failed/blocked/cancelled
  targetArea: text("target_area"), // 担当領域（コンフリクト制御用）
  touches: text("touches").array().default([]).notNull(), // 変更対象のファイル/ディレクトリ
  dependencies: uuid("dependencies").array().default([]).notNull(), // 先行タスクID
  timeboxMinutes: integer("timebox_minutes").default(60).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 実行記録テーブル: エージェントの実行履歴
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .references(() => tasks.id)
    .notNull(),
  agentId: text("agent_id").notNull(), // 実行エージェント識別子
  status: text("status").default("running").notNull(), // running/success/failed/cancelled
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  costTokens: integer("cost_tokens"), // 消費トークン数
  logPath: text("log_path"), // ログファイルパス
  errorMessage: text("error_message"),
});

// 成果物テーブル: PR、コミット、CI結果など
export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => runs.id)
    .notNull(),
  type: text("type").notNull(), // pr/commit/ci_result/branch
  ref: text("ref"), // PR番号、コミットSHA等
  url: text("url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// リーステーブル: タスクの一時的な占有権（ロックの代替）
export const leases = pgTable("leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .references(() => tasks.id)
    .unique()
    .notNull(),
  agentId: text("agent_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// イベントログテーブル: 監査用
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // task.created, run.started, pr.merged, etc.
  entityType: text("entity_type").notNull(), // task, run, artifact, etc.
  entityId: uuid("entity_id").notNull(),
  agentId: text("agent_id"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// エージェントテーブル: 登録されたエージェント
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  role: text("role").notNull(), // planner/worker/judge
  status: text("status").default("idle").notNull(), // idle/busy/offline
  currentTaskId: uuid("current_task_id").references(() => tasks.id),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// サイクルテーブル: 運用サイクルの管理（クリーン再スタート用）
export const cycles = pgTable("cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number").notNull(), // サイクル番号（1, 2, 3...）
  status: text("status").default("running").notNull(), // running/completed/aborted
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  // サイクル終了条件
  triggerType: text("trigger_type"), // time/task_count/failure_rate/manual
  // サイクル開始時の状態スナップショット
  stateSnapshot: jsonb("state_snapshot"),
  // サイクル統計
  stats: jsonb("stats"), // { tasksCompleted, tasksFailed, totalTokens, etc. }
  // サイクル終了理由
  endReason: text("end_reason"),
  metadata: jsonb("metadata"),
});

// 型エクスポート
export type TaskRecord = typeof tasks.$inferSelect;
export type NewTaskRecord = typeof tasks.$inferInsert;

export type RunRecord = typeof runs.$inferSelect;
export type NewRunRecord = typeof runs.$inferInsert;

export type ArtifactRecord = typeof artifacts.$inferSelect;
export type NewArtifactRecord = typeof artifacts.$inferInsert;

export type LeaseRecord = typeof leases.$inferSelect;
export type NewLeaseRecord = typeof leases.$inferInsert;

export type EventRecord = typeof events.$inferSelect;
export type NewEventRecord = typeof events.$inferInsert;

export type AgentRecord = typeof agents.$inferSelect;
export type NewAgentRecord = typeof agents.$inferInsert;

export type CycleRecord = typeof cycles.$inferSelect;
export type NewCycleRecord = typeof cycles.$inferInsert;
