import { z } from "zod";

// エージェントの役割
export const AgentRole = z.enum([
  "planner", // タスク生成・分割
  "worker", // 実装・PR作成
  "judge", // 採用判定
  "tester", // テスト作成・実行
]);
export type AgentRole = z.infer<typeof AgentRole>;

// エージェントのステータス
export const AgentStatus = z.enum([
  "idle", // 待機中
  "busy", // 作業中
  "offline", // オフライン
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

// エージェント定義スキーマ
export const AgentSchema = z.object({
  id: z.string(),
  role: AgentRole,
  status: AgentStatus.default("idle"),
  currentTaskId: z.string().uuid().nullable(), // 現在実行中のタスク
  lastHeartbeat: z.date().nullable(), // 最終ハートビート
  metadata: z
    .object({
      model: z.string().optional(), // 使用モデル
      provider: z.string().optional(), // プロバイダー
      version: z.string().optional(), // エージェントバージョン
    })
    .optional(),
  createdAt: z.date(),
});
export type Agent = z.infer<typeof AgentSchema>;

// エージェント登録時の入力スキーマ
export const RegisterAgentInput = z.object({
  id: z.string(),
  role: AgentRole,
  metadata: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;
