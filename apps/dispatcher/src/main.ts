import { db } from "@h1ve/db";
import { tasks, leases } from "@h1ve/db/schema";
import { eq, and, lt, isNull, or, notInArray } from "drizzle-orm";

// ディスパッチャー: タスクをWorkerに割り当てる
// 1. queued状態のタスクを取得
// 2. 依存関係を確認
// 3. 優先度でソート
// 4. 空いているWorkerにリース発行

const POLL_INTERVAL_MS = 5000; // 5秒ごとにポーリング
const LEASE_DURATION_MINUTES = 60; // リースの有効期限

async function cleanupExpiredLeases(): Promise<void> {
  // 期限切れリースを削除
  const now = new Date();
  await db.delete(leases).where(lt(leases.expiresAt, now));
}

async function getQueuedTasks() {
  // 依存関係が解決済みのqueuedタスクを取得
  const queuedTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, "queued"));

  // 既にリースが取得されているタスクを除外
  const leasedTaskIds = await db.select({ taskId: leases.taskId }).from(leases);
  const leasedIds = new Set(leasedTaskIds.map((l) => l.taskId));

  // 完了済みタスクのIDを取得
  const doneTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "done"));
  const doneIds = new Set(doneTasks.map((t) => t.id));

  // 依存関係が解決済みかつリースされていないタスクをフィルタ
  const availableTasks = queuedTasks.filter((task) => {
    if (leasedIds.has(task.id)) return false;

    // 全ての依存タスクが完了しているか確認
    const deps = task.dependencies ?? [];
    return deps.every((depId) => doneIds.has(depId));
  });

  // 優先度でソート（高い順）
  return availableTasks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

async function dispatchTask(taskId: string, agentId: string): Promise<boolean> {
  // リースを取得（楽観的並行制御）
  const expiresAt = new Date(Date.now() + LEASE_DURATION_MINUTES * 60 * 1000);

  try {
    await db.insert(leases).values({
      taskId,
      agentId,
      expiresAt,
    });

    // タスクをrunning状態に更新
    await db
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    console.log(`Task ${taskId} dispatched to agent ${agentId}`);
    return true;
  } catch (error) {
    // リース取得に失敗（既に他のエージェントが取得済み）
    console.log(`Failed to dispatch task ${taskId}: already leased`);
    return false;
  }
}

async function runDispatchLoop(): Promise<void> {
  console.log("Dispatcher started");

  while (true) {
    try {
      // 期限切れリースをクリーンアップ
      await cleanupExpiredLeases();

      // 利用可能なタスクを取得
      const availableTasks = await getQueuedTasks();

      if (availableTasks.length > 0) {
        console.log(`Found ${availableTasks.length} available tasks`);

        // TODO: 空いているWorkerを取得してディスパッチ
        // 現時点では単にログ出力
        for (const task of availableTasks) {
          console.log(`  - ${task.title} (priority: ${task.priority})`);
        }
      }
    } catch (error) {
      console.error("Dispatch loop error:", error);
    }

    // 次のポーリングまで待機
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// メイン処理
runDispatchLoop().catch(console.error);
