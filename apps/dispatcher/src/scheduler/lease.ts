import { db } from "@openTiger/db";
import { leases, tasks, agents, runs } from "@openTiger/db/schema";
import { eq, lt, and } from "drizzle-orm";

// リースのデフォルト期限（分）
const DEFAULT_LEASE_DURATION_MINUTES = 60;

// リース取得結果
export interface LeaseResult {
  success: boolean;
  leaseId?: string;
  error?: string;
}

async function markAgentIdleIfNoActiveWork(agentId: string): Promise<void> {
  const [activeLease] = await db
    .select({ id: leases.id })
    .from(leases)
    .where(eq(leases.agentId, agentId))
    .limit(1);

  if (activeLease) {
    return;
  }

  const [activeRun] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")))
    .limit(1);

  if (activeRun) {
    return;
  }

  await db
    .update(agents)
    .set({
      status: "idle",
      currentTaskId: null,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}

// リースを取得
export async function acquireLease(
  taskId: string,
  agentId: string,
  durationMinutes: number = DEFAULT_LEASE_DURATION_MINUTES,
): Promise<LeaseResult> {
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

  try {
    // 既存のリースがないか確認
    const existingLease = await db.select().from(leases).where(eq(leases.taskId, taskId));

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
  const [lease] = await db
    .select({ agentId: leases.agentId })
    .from(leases)
    .where(eq(leases.taskId, taskId))
    .limit(1);
  await db.delete(leases).where(eq(leases.taskId, taskId));
  if (lease?.agentId) {
    await markAgentIdleIfNoActiveWork(lease.agentId);
  }
  return true;
}

// リースを延長
export async function extendLease(
  taskId: string,
  additionalMinutes: number = DEFAULT_LEASE_DURATION_MINUTES,
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
  const expiredLeases = await db.select().from(leases).where(lt(leases.expiresAt, now));

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
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, lease.taskId), eq(tasks.status, "running")));

    await markAgentIdleIfNoActiveWork(lease.agentId);
  }

  // 期限切れリースを削除
  await db.delete(leases).where(lt(leases.expiresAt, now));

  return expiredLeases.length;
}

// queuedタスクに残留したダングリングleaseを回収する
// 例: worker再起動などでrun未生成のままleaseだけ残るケース
export async function cleanupDanglingLeases(): Promise<number> {
  const allLeases = await db
    .select({ id: leases.id, taskId: leases.taskId, agentId: leases.agentId })
    .from(leases);

  if (allLeases.length === 0) {
    return 0;
  }

  let reclaimed = 0;
  for (const lease of allLeases) {
    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, lease.taskId));
    if (!task) {
      await db.delete(leases).where(eq(leases.id, lease.id));
      reclaimed += 1;
      await markAgentIdleIfNoActiveWork(lease.agentId);
      continue;
    }

    if (task.status !== "queued") {
      continue;
    }

    const activeRun = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, lease.taskId), eq(runs.status, "running")))
      .limit(1);

    if (activeRun.length === 0) {
      await db.delete(leases).where(eq(leases.id, lease.id));
      reclaimed += 1;
      await markAgentIdleIfNoActiveWork(lease.agentId);
    }
  }

  return reclaimed;
}

// running のまま固着したタスクを回復する
// 例: run は failed/cancelled なのに task.status=running, lease だけ残っているケース
export async function recoverOrphanedRunningTasks(graceMs: number = 120000): Promise<number> {
  const threshold = new Date(Date.now() - graceMs);

  const candidates = await db
    .select({ id: tasks.id, updatedAt: tasks.updatedAt })
    .from(tasks)
    .where(and(eq(tasks.status, "running"), lt(tasks.updatedAt, threshold)));

  if (candidates.length === 0) {
    return 0;
  }

  let recovered = 0;
  for (const task of candidates) {
    const activeRun = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")))
      .limit(1);
    if (activeRun.length > 0) {
      continue;
    }

    const taskLeases = await db
      .select({ id: leases.id, agentId: leases.agentId })
      .from(leases)
      .where(eq(leases.taskId, task.id));
    await db.delete(leases).where(eq(leases.taskId, task.id));
    for (const lease of taskLeases) {
      await markAgentIdleIfNoActiveWork(lease.agentId);
    }
    await db
      .update(tasks)
      .set({
        status: "queued",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    recovered++;
  }

  return recovered;
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
