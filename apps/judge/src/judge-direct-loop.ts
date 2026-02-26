import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { and, eq } from "drizzle-orm";
import type { JudgeConfig } from "./judge-config";

/**
 * Direct mode judge loop.
 *
 * In direct mode, workers transition tasks directly to `done` without
 * creating PRs or worktrees for review. The judge loop is therefore
 * mostly idle but maintains a polling heartbeat for:
 * - Plugin hook extension points
 * - Fallback safety: if any task is stuck in `awaiting_judge`, auto-approve it
 */
export async function runDirectJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("[Judge] Direct mode: tasks auto-complete without review");
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log("=".repeat(60));

  while (true) {
    try {
      // Fallback safety: auto-approve any tasks stuck in awaiting_judge
      const stuckTasks = await db
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(and(eq(tasks.status, "blocked"), eq(tasks.blockReason, "awaiting_judge")))
        .limit(10);

      if (stuckTasks.length > 0) {
        console.log(
          `[Judge] Direct mode: found ${stuckTasks.length} task(s) stuck in awaiting_judge, auto-approving`,
        );
        for (const task of stuckTasks) {
          await db
            .update(tasks)
            .set({
              status: "done",
              blockReason: null,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, task.id));
          console.log(`[Judge] Auto-approved task: ${task.title} (${task.id})`);
        }
      }
    } catch (error) {
      console.error("[Judge] Direct mode loop error:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
