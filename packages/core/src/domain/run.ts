import { z } from "zod";

// 実行ステータス
export const RunStatus = z.enum([
  "running", // 実行中
  "success", // 成功
  "failed", // 失敗
  "cancelled", // キャンセル
]);
export type RunStatus = z.infer<typeof RunStatus>;

// 実行記録スキーマ
export const RunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string(), // 実行したエージェントの識別子
  status: RunStatus.default("running"),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  costTokens: z.number().int().nonnegative().nullable(), // 消費トークン数
  logPath: z.string().nullable(), // ログファイルパス
  errorMessage: z.string().nullable(), // エラーメッセージ
});
export type Run = z.infer<typeof RunSchema>;

// 実行開始時の入力スキーマ
export const StartRunInput = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
});
export type StartRunInput = z.infer<typeof StartRunInput>;

// 実行完了時の入力スキーマ
export const CompleteRunInput = z.object({
  status: z.enum(["success", "failed", "cancelled"]),
  costTokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
});
export type CompleteRunInput = z.infer<typeof CompleteRunInput>;
