import { db } from "@sebastian-code/db";
import { leases, tasks, agents } from "@sebastian-code/db/schema";
import { eq, lt, and } from "drizzle-orm";

// リースのデフォルト期限（分）
const DEFAULT_LEASE_DURATION_MINUTES = 60;

// リース取得結果
export interface LeaseResult {
  success: boolean;
  leaseId?: string;
  error?: string;
}

// リースを取得
export async function acquireLease(
  taskId: string,
  agentId: string,
  durationMinutes: number = DEFAULT_LEASE_DURATION_MINUTES
): Promise<LeaseResult> {
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

  try {
    // 既存のリースがないか確認
    const existingLease = await db
      .select()
      .from(leases)
      .where(eq(leases.taskId, taskId));

    if (existingLease.length > 0) {
      return {
        success: false,
        error: "Task already has an active lease",
      };
    }

    // リースを作成
    const result = await db
      .insert(leases)
      .values({
        taskId,
        agentId,
        expiresAt,
      })
      .returning();

    const created = result[0];
    if (!created) {
      return {
        success: false,
        error: "Failed to create lease",
      };
    }

    return {
      success: true,
      leaseId: created.id,
    };
  } catch (error) {
    // 一意制約違反（他のエージェントが先にリースを取得）
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// リースを解放
export async function releaseLease(taskId: string): Promise<boolean> {
  const result = await db.delete(leases).where(eq(leases.taskId, taskId));
  return true;
}

// リースを延長
export async function extendLease(
  taskId: string,
  additionalMinutes: number = DEFAULT_LEASE_DURATION_MINUTES
): Promise<boolean> {
  const newExpiresAt = new Date(Date.now() + additionalMinutes * 60 * 1000);

  const result = await db
    .update(leases)
    .set({ expiresAt: newExpiresAt })
    .where(eq(leases.taskId, taskId))
    .returning();

  return result.length > 0;
}

// 期限切れリースをクリーンアップ
export async function cleanupExpiredLeases(): Promise<number> {
  const now = new Date();

  // 期限切れリースを取得
  const expiredLeases = await db
    .select()
    .from(leases)
    .where(lt(leases.expiresAt, now));

  if (expiredLeases.length === 0) {
    return 0;
  }

  // 期限切れリースのタスクをqueuedに戻す
  for (const lease of expiredLeases) {
    // タスクの情報を取得
    const [task] = await db.select().from(tasks).where(eq(tasks.id, lease.taskId));
    
    // 失敗回数をカウント（context.retryCount などに持たせることも検討できるが、
    // 現状はシンプルに status を queued に戻す。
    // ただし、何度も失敗している場合は blocked にするなどのロジックをここに追加可能）
    
    await db
      .update(tasks)
      .set({
        status: "queued",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, lease.taskId));
  }

  // 期限切れリースを削除
  await db.delete(leases).where(lt(leases.expiresAt, now));

  return expiredLeases.length;
}

// 特定エージェントのリースを取得
export async function getAgentLeases(agentId: string) {
  return db.select().from(leases).where(eq(leases.agentId, agentId));
}

// 全アクティブリースを取得（有効期限が現在より後のもの）
export async function getAllActiveLeases() {
  const now = new Date();
  // now < expiresAt => expiresAtがnowより大きい
  // gt(leases.expiresAt, now) を使用
  const { gt } = await import("drizzle-orm");
  return db.select().from(leases).where(gt(leases.expiresAt, now));
}
