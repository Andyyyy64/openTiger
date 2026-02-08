import { z } from "zod";

// ポリシー: エージェントの行動制約を定義
export const PolicySchema = z.object({
  // 変更を許可するパス（glob）
  allowedPaths: z.array(z.string()).default(["**/*"]),

  // 変更を禁止するパス（glob）
  deniedPaths: z.array(z.string()).default([]),

  // 変更行数の上限
  maxLinesChanged: z.number().int().positive().default(500),

  // 変更ファイル数の上限
  maxFilesChanged: z.number().int().positive().default(20),

  // 禁止コマンド（正規表現）
  deniedCommands: z.array(z.string()).default([
    "rm -rf /",
    "sudo",
    "chmod 777",
  ]),

  // 自動マージの条件
  autoMerge: z
    .object({
      enabled: z.boolean().default(false),
      // 自動マージを許可するリスクレベル
      maxRiskLevel: z.enum(["low", "medium", "high"]).default("low"),
      // 必須のCIチェック名
      requiredChecks: z.array(z.string()).default([]),
    })
    .default({}),

  // ローカルベースリポジトリ復旧の厳しさ
  baseRepoRecovery: z
    .object({
      level: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .default({}),

  // トークン制限
  tokenLimits: z
    .object({
      perTask: z.number().int().positive().default(1000000),
      perDay: z.number().int().positive().default(50000000),
    })
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

// デフォルトポリシー
export const DEFAULT_POLICY: Policy = PolicySchema.parse({});
