import { z } from "zod";

// サイクルの状態
export const CycleStatusSchema = z.enum([
  "running", // 実行中
  "completed", // 正常終了
  "aborted", // 異常終了・手動停止
]);
export type CycleStatus = z.infer<typeof CycleStatusSchema>;

// サイクル終了のトリガータイプ
export const CycleTriggerTypeSchema = z.enum([
  "time", // 時間ベース（例: 4時間ごと）
  "task_count", // タスク数ベース（例: 100タスク完了ごと）
  "failure_rate", // 失敗率ベース（例: 失敗率20%超過時）
  "manual", // 手動トリガー
]);
export type CycleTriggerType = z.infer<typeof CycleTriggerTypeSchema>;

// サイクル統計情報
export const CycleStatsSchema = z.object({
  tasksCompleted: z.number().default(0),
  tasksFailed: z.number().default(0),
  tasksCancelled: z.number().default(0),
  runsTotal: z.number().default(0),
  totalTokens: z.number().default(0),
  prsCreated: z.number().default(0),
  prsMerged: z.number().default(0),
  prsRejected: z.number().default(0),
  averageTaskDurationMs: z.number().optional(),
  peakConcurrentWorkers: z.number().default(0),
});
export type CycleStats = z.infer<typeof CycleStatsSchema>;

// 状態スナップショット: サイクル開始時の状態を保存
export const StateSnapshotSchema = z.object({
  pendingTaskCount: z.number(),
  runningTaskCount: z.number(),
  activeAgentCount: z.number(),
  queuedJobCount: z.number(),
  timestamp: z.coerce.date(),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

// サイクル設定
export const CycleConfigSchema = z.object({
  // 時間ベースのサイクル制御
  maxDurationMs: z.number().optional(), // 最大実行時間（ミリ秒）
  // タスク数ベースのサイクル制御
  maxTasksPerCycle: z.number().optional(), // サイクルあたりの最大タスク数
  // 失敗率ベースのサイクル制御
  maxFailureRate: z.number().min(0).max(1).optional(), // 最大失敗率（0-1）
  minTasksForFailureCheck: z.number().default(10), // 失敗率計算に必要な最小タスク数
  // クリーン再スタート設定
  cleanupOnEnd: z.boolean().default(true), // サイクル終了時にクリーンアップ
  preserveTaskState: z.boolean().default(true), // 失敗/ブロックタスクの状態を保持
  // 監視設定
  statsIntervalMs: z.number().default(60000), // 統計更新間隔
  healthCheckIntervalMs: z.number().default(30000), // ヘルスチェック間隔
});
export type CycleConfig = z.infer<typeof CycleConfigSchema>;

// サイクルドメインモデル
export const CycleSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  status: CycleStatusSchema,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  triggerType: CycleTriggerTypeSchema.optional(),
  stateSnapshot: StateSnapshotSchema.optional(),
  stats: CycleStatsSchema.optional(),
  endReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Cycle = z.infer<typeof CycleSchema>;

// サイクル作成用入力
export const NewCycleSchema = CycleSchema.omit({
  id: true,
  endedAt: true,
  endReason: true,
}).partial({
  status: true,
  startedAt: true,
  triggerType: true,
  stateSnapshot: true,
  stats: true,
  metadata: true,
});
export type NewCycle = z.infer<typeof NewCycleSchema>;

// サイクル終了イベント
export const CycleEndEventSchema = z.object({
  cycleId: z.string().uuid(),
  triggerType: CycleTriggerTypeSchema,
  reason: z.string(),
  stats: CycleStatsSchema,
});
export type CycleEndEvent = z.infer<typeof CycleEndEventSchema>;

// 異常検知アラート
export const AnomalyAlertSchema = z.object({
  type: z.enum([
    "high_failure_rate", // 高い失敗率
    "cost_spike", // コスト急増
    "stuck_task", // 長時間停止タスク
    "no_progress", // 進捗なし
    "memory_leak", // メモリリーク疑い
    "agent_timeout", // エージェントタイムアウト
  ]),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  timestamp: z.coerce.date(),
});
export type AnomalyAlert = z.infer<typeof AnomalyAlertSchema>;
