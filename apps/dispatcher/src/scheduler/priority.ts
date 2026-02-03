import { db } from "@sebastian-code/db";
import { tasks, leases, runs } from "@sebastian-code/db/schema";
import { eq, and, inArray, gt } from "drizzle-orm";

// タスク選択結果
export interface AvailableTask {
  id: string;
  title: string;
  goal: string;
  priority: number;
  riskLevel: string;
  role: string;
  timeboxMinutes: number;
  dependencies: string[];
  allowedPaths: string[];
  commands: string[];
  context: Record<string, unknown> | null;
  targetArea: string | null;
  touches: string[];
}

const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

function getRetryDelayMs(): number {
  const raw = process.env.DISPATCH_RETRY_DELAY_MS ?? String(DEFAULT_RETRY_DELAY_MS);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_DELAY_MS;
  }

  return parsed;
}

// 利用可能なタスクを優先度順で取得
export async function getAvailableTasks(): Promise<AvailableTask[]> {
  // queuedステータスのタスクを取得
  const queuedTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, "queued"));

  if (queuedTasks.length === 0) {
    console.log("[Priority] No queued tasks found");
    return [];
  }

  console.log(`[Priority] Found ${queuedTasks.length} queued tasks`);

  const cooldownBlockedIds = new Set<string>();
  const retryDelayMs = getRetryDelayMs();

  if (retryDelayMs > 0) {
    const queuedIds = queuedTasks.map((task) => task.id);
    const cutoff = new Date(Date.now() - retryDelayMs);
    const recentFailures = await db
      .select({ taskId: runs.taskId })
      .from(runs)
      .where(
        and(
          inArray(runs.taskId, queuedIds),
          inArray(runs.status, ["failed", "cancelled"]),
          gt(runs.finishedAt, cutoff)
        )
      );

    for (const run of recentFailures) {
      cooldownBlockedIds.add(run.taskId);
    }
  }

  // リース済みタスクIDを取得
  const leasedTasks = await db.select({ taskId: leases.taskId }).from(leases);
  const leasedIds = new Set(leasedTasks.map((l) => l.taskId));

  // 実行中のタスクから targetArea を取得
  const runningTasks = await db
    .select({ targetArea: tasks.targetArea })
    .from(tasks)
    .where(eq(tasks.status, "running"));
  const activeTargetAreas = new Set(
    runningTasks.map((t) => t.targetArea).filter((a): a is string => !!a)
  );

  // 完了済みタスクIDを取得
  const doneTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "done"));
  const doneIds = new Set(doneTasks.map((t) => t.id));

  // フィルタリング: リースなし、依存関係解決済み、targetArea の衝突なし
  const available = queuedTasks.filter((task) => {
    // 直近失敗の再配布はクールダウンする
    if (cooldownBlockedIds.has(task.id)) {
      console.log(`[Priority] Task ${task.id} blocked by cooldown`);
      return false;
    }

    // リース済みは除外
    if (leasedIds.has(task.id)) {
      console.log(`[Priority] Task ${task.id} blocked by lease`);
      return false;
    }

    // targetArea が衝突している場合は除外
    if (task.targetArea && activeTargetAreas.has(task.targetArea)) {
      console.log(`[Priority] Task ${task.id} blocked by targetArea conflict`);
      return false;
    }

    // 依存関係のチェック
    const deps = task.dependencies ?? [];
    const unresolvedDeps = deps.filter((depId) => !doneIds.has(depId));
    if (unresolvedDeps.length > 0) {
      console.log(`[Priority] Task ${task.id} blocked by unresolved deps: ${unresolvedDeps.join(", ")}`);
      return false;
    }

    return true;
  });

  console.log(`[Priority] ${available.length} tasks passed filters`);

  // 優先度スコアを計算してソート
  const scored = available.map((task) => ({
    task,
    score: calculatePriorityScore(task),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.map(({ task }) => ({
    id: task.id,
    title: task.title,
    goal: task.goal,
    priority: task.priority ?? 0,
    riskLevel: task.riskLevel ?? "low",
    role: task.role ?? "worker",
    timeboxMinutes: task.timeboxMinutes ?? 60,
    dependencies: task.dependencies ?? [],
    allowedPaths: task.allowedPaths ?? [],
    commands: task.commands ?? [],
    context: task.context as Record<string, unknown> | null,
    targetArea: task.targetArea,
    touches: task.touches ?? [],
  }));
}

// 優先度スコアを計算
function calculatePriorityScore(task: {
  priority: number | null;
  riskLevel: string | null;
  createdAt: Date;
  timeboxMinutes: number | null;
}): number {
  let score = 0;

  // 基本優先度（0-100）
  score += (task.priority ?? 0) * 10;

  // リスクレベルによる調整（低リスクを優先）
  const riskMultiplier: Record<string, number> = {
    low: 1.5,
    medium: 1.0,
    high: 0.5,
  };
  score *= riskMultiplier[task.riskLevel ?? "low"] ?? 1.0;

  // 待機時間による調整（古いタスクを優先）
  const waitingHours =
    (Date.now() - task.createdAt.getTime()) / (1000 * 60 * 60);
  score += Math.min(waitingHours * 2, 20); // 最大20ポイント

  // 短いタスクを若干優先
  const timebox = task.timeboxMinutes ?? 60;
  if (timebox <= 30) {
    score += 5;
  }

  return score;
}

// 依存関係グラフを構築
export async function buildDependencyGraph(): Promise<
  Map<string, Set<string>>
> {
  const allTasks = await db.select().from(tasks);
  const graph = new Map<string, Set<string>>();

  for (const task of allTasks) {
    const deps = new Set(task.dependencies ?? []);
    graph.set(task.id, deps);
  }

  return graph;
}

// 循環依存を検出
export function detectCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const deps = graph.get(node) ?? new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep)) {
          return true;
        }
      } else if (recursionStack.has(dep)) {
        // 循環検出
        const cycleStart = path.indexOf(dep);
        cycles.push(path.slice(cycleStart));
        return true;
      }
    }

    path.pop();
    recursionStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}
