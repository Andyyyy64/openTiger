import { z } from "zod";

// タスクのリスクレベル
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

// タスクの担当ロール
export const TaskRole = z.enum(["worker", "tester", "docser"]);
export type TaskRole = z.infer<typeof TaskRole>;

// タスクのステータス
export const TaskStatus = z.enum([
  "queued", // 待機中
  "running", // 実行中
  "done", // 完了
  "failed", // 失敗
  "blocked", // ブロック（依存待ち or 人間の介入待ち）
  "cancelled", // キャンセル
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// タスクのコンテキスト情報
export const TaskContext = z.object({
  files: z.array(z.string()).optional(), // 関連ファイル
  specs: z.string().optional(), // 仕様・要件
  notes: z.string().optional(), // 補足情報
  issue: z
    .object({
      number: z.number().int(),
      url: z.string().url().optional(),
      title: z.string().optional(),
    })
    .optional(), // Issueの紐づけ情報
});
export type TaskContext = z.infer<typeof TaskContext>;

// タスク定義スキーマ
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  goal: z.string().min(1), // 完了条件（機械判定可能な形式）
  context: TaskContext.optional(),
  allowedPaths: z.array(z.string()), // 変更を許可するパス
  commands: z.array(z.string()), // 検証コマンド
  priority: z.number().int().default(0),
  riskLevel: RiskLevel.default("low"),
  role: TaskRole.default("worker"),
  status: TaskStatus.default("queued"),
  targetArea: z.string().optional(), // 担当領域（コンフリクト制御用）
  touches: z.array(z.string()).default([]), // 変更対象のファイル/ディレクトリ
  dependencies: z.array(z.string().uuid()).default([]), // 先行タスクID
  timeboxMinutes: z.number().int().positive().default(60),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Task = z.infer<typeof TaskSchema>;

// タスク作成時の入力スキーマ
export const CreateTaskInput = TaskSchema.omit({
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  priority: true,
  riskLevel: true,
  dependencies: true,
  timeboxMinutes: true,
  context: true,
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

// タスク更新時の入力スキーマ
export const UpdateTaskInput = TaskSchema.partial().omit({
  id: true,
  createdAt: true,
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;
