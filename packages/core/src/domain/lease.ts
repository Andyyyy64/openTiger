import { z } from "zod";

// リース（タスクの一時的な占有権）
// ロックの代わりに期限付きリースを使用することで、
// エージェントが異常終了してもシステムが回復できる
export const LeaseSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string(),
  expiresAt: z.date(), // 期限切れで自動解放
  createdAt: z.date(),
});
export type Lease = z.infer<typeof LeaseSchema>;

// リース取得時の入力スキーマ
export const AcquireLeaseInput = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
  durationMinutes: z.number().int().positive().default(60),
});
export type AcquireLeaseInput = z.infer<typeof AcquireLeaseInput>;

// リースが有効かどうかを判定
export function isLeaseValid(lease: Lease): boolean {
  return lease.expiresAt > new Date();
}

// リースの残り時間（ミリ秒）を取得
export function getLeaseRemainingMs(lease: Lease): number {
  return Math.max(0, lease.expiresAt.getTime() - Date.now());
}
