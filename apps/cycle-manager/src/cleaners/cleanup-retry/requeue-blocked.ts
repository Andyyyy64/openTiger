import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import { computeQuotaBackoff } from "@openTiger/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { recordEvent } from "../../monitors/event-logger";
import { hasPendingJudgeRun, restoreLatestJudgeRun } from "./judge-recovery";
import { isPrReviewTask, normalizeBlockReason, normalizeContext } from "./task-context";

const DEFAULT_QUOTA_BASE_DELAY_MS = 30_000;
const DEFAULT_QUOTA_MAX_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_QUOTA_BACKOFF_FACTOR = 2;
const DEFAULT_QUOTA_JITTER_RATIO = 0.2;
const VERIFY_REWORK_MARKER_PREFIX = "[verify-rework-json]";

type VerifyReworkMeta = {
  failedCommand?: string;
  failedCommandSource?: string;
  stderrSummary?: string;
};

export function extractVerifyReworkMeta(notes: string | undefined): VerifyReworkMeta | null {
  const lines = (notes ?? "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(VERIFY_REWORK_MARKER_PREFIX)) {
      continue;
    }
    const payload = trimmed.slice(VERIFY_REWORK_MARKER_PREFIX.length).trim();
    if (!payload) {
      continue;
    }
    try {
      const parsed = JSON.parse(decodeURIComponent(payload)) as VerifyReworkMeta;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

export function stripVerifyReworkMarkers(notes: string | undefined): string | undefined {
  if (!notes) {
    return notes;
  }
  const filtered = notes
    .split("\n")
    .filter((line) => !line.trim().startsWith(VERIFY_REWORK_MARKER_PREFIX));
  const joined = filtered.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

function parseEnvFloat(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

function resolveQuotaBackoffConfig(fallbackBaseDelayMs: number): {
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterRatio: number;
} {
  const opencodeDelayMs = parseEnvInt("OPENCODE_QUOTA_RETRY_DELAY_MS", DEFAULT_QUOTA_BASE_DELAY_MS);
  const baseDelayMs = parseEnvInt(
    "QUOTA_BACKOFF_BASE_MS",
    Math.max(opencodeDelayMs, Math.min(fallbackBaseDelayMs, 5 * 60 * 1000)),
  );
  const maxDelayMs = parseEnvInt("QUOTA_BACKOFF_MAX_MS", DEFAULT_QUOTA_MAX_DELAY_MS);
  const factor = parseEnvFloat("QUOTA_BACKOFF_FACTOR", DEFAULT_QUOTA_BACKOFF_FACTOR);
  const jitterRatio = parseEnvFloat("QUOTA_BACKOFF_JITTER_RATIO", DEFAULT_QUOTA_JITTER_RATIO);
  return {
    baseDelayMs,
    maxDelayMs,
    factor,
    jitterRatio,
  };
}

// blockedタスクをクールダウン後に再キュー（リトライ回数制限付き）
export async function requeueBlockedTasksWithCooldown(
  cooldownMs: number = 5 * 60 * 1000,
): Promise<number> {
  const blockedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      context: tasks.context,
      allowedPaths: tasks.allowedPaths,
      commands: tasks.commands,
      priority: tasks.priority,
      riskLevel: tasks.riskLevel,
      role: tasks.role,
      dependencies: tasks.dependencies,
      timeboxMinutes: tasks.timeboxMinutes,
      blockReason: tasks.blockReason,
      updatedAt: tasks.updatedAt,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .where(eq(tasks.status, "blocked"));

  if (blockedTasks.length === 0) {
    return 0;
  }

  const quotaBlockedIds = blockedTasks
    .filter((task) => normalizeBlockReason(task.blockReason) === "quota_wait")
    .map((task) => task.id);

  const latestQuotaFailureByTaskId = new Map<string, string | null>();
  if (quotaBlockedIds.length > 0) {
    const quotaRuns = await db
      .select({
        taskId: runs.taskId,
        errorMessage: runs.errorMessage,
      })
      .from(runs)
      .where(
        and(inArray(runs.taskId, quotaBlockedIds), inArray(runs.status, ["failed", "cancelled"])),
      )
      .orderBy(desc(runs.finishedAt), desc(runs.startedAt));

    for (const row of quotaRuns) {
      if (!latestQuotaFailureByTaskId.has(row.taskId)) {
        latestQuotaFailureByTaskId.set(row.taskId, row.errorMessage);
      }
    }
  }

  const quotaBackoff = resolveQuotaBackoffConfig(cooldownMs);
  let handled = 0;

  for (const task of blockedTasks) {
    const reason = normalizeBlockReason(task.blockReason);
    let requiredCooldownMs = cooldownMs;
    if (reason === "quota_wait") {
      const backoff = computeQuotaBackoff({
        taskId: task.id,
        retryCount: task.retryCount ?? 0,
        baseDelayMs: quotaBackoff.baseDelayMs,
        maxDelayMs: quotaBackoff.maxDelayMs,
        factor: quotaBackoff.factor,
        jitterRatio: quotaBackoff.jitterRatio,
        errorMessage: latestQuotaFailureByTaskId.get(task.id),
      });
      requiredCooldownMs = backoff.cooldownMs;
    }

    const retryAtMs = task.updatedAt.getTime() + requiredCooldownMs;
    const cooldownPassed = retryAtMs <= Date.now();
    // 復旧を止めないため、上限に関わらずcooldownだけで再処理する
    if (!cooldownPassed) {
      continue;
    }

    const nextRetryCount = (task.retryCount ?? 0) + 1;

    if (reason === "needs_rework") {
      if (
        isPrReviewTask({
          title: task.title,
          goal: task.goal,
          context: task.context,
        })
      ) {
        const hasPendingRun = await hasPendingJudgeRun(task.id);
        let recoveredRunId: string | null = null;
        if (!hasPendingRun) {
          recoveredRunId = await restoreLatestJudgeRun(task.id);
        }

        await db
          .update(tasks)
          .set({
            status: "blocked",
            blockReason: "awaiting_judge",
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: hasPendingRun
              ? "pr_review_needs_rework_to_awaiting_judge"
              : "pr_review_needs_rework_run_restored",
            runId: recoveredRunId,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Routed blocked PR-review task back to awaiting_judge: ${task.id}`);
        handled++;
        continue;
      }

      // needs_rework は親タスクをfailed化し、分割した再作業タスクを自動生成する
      const context = normalizeContext(task.context);
      const verifyReworkMeta = extractVerifyReworkMeta(context.notes);
      const baseNotes = stripVerifyReworkMarkers(context.notes);
      const verifySummaryLines =
        verifyReworkMeta && verifyReworkMeta.failedCommand
          ? [
              "[verify-rework] previous verification failure",
              `- command: ${verifyReworkMeta.failedCommand}`,
              `- source: ${verifyReworkMeta.failedCommandSource ?? "unknown"}`,
              `- stderr: ${verifyReworkMeta.stderrSummary ?? "stderr unavailable"}`,
            ]
          : [];
      const notes = [
        baseNotes,
        verifySummaryLines.join("\n"),
        `[auto-rework] parentTask=${task.id}`,
      ]
        .filter((part) => Boolean(part && part.length > 0))
        .join("\n");
      const baseSpecs = context.specs?.trim();
      const verifySpecs =
        verifyReworkMeta && verifyReworkMeta.failedCommand
          ? `Focus on recovering failed verification command:\n- ${verifyReworkMeta.failedCommand}\n- source: ${verifyReworkMeta.failedCommandSource ?? "unknown"}`
          : "";
      const mergedSpecs = [baseSpecs, verifySpecs]
        .filter((part) => Boolean(part && part.length > 0))
        .join("\n\n");
      const isReworkTitle =
        task.title.startsWith("[Rework]") || task.title.startsWith("[Rework-Verify]");
      const titlePrefix = verifyReworkMeta ? "[Rework-Verify]" : "[Rework]";
      const reworkTitle = isReworkTitle ? task.title : `${titlePrefix} ${task.title}`;

      const [reworkTask] = await db
        .insert(tasks)
        .values({
          title: reworkTitle,
          goal: task.goal,
          context: {
            ...context,
            specs: mergedSpecs.length > 0 ? mergedSpecs : context.specs,
            notes,
          },
          allowedPaths: task.allowedPaths ?? [],
          commands: task.commands ?? [],
          priority: (task.priority ?? 0) + 5,
          riskLevel: task.riskLevel ?? "medium",
          role: task.role ?? "worker",
          dependencies: task.dependencies ?? [],
          timeboxMinutes: Math.max(30, Math.floor((task.timeboxMinutes ?? 60) * 0.8)),
          status: "queued",
          blockReason: null,
        })
        .returning({ id: tasks.id });

      await db
        .update(tasks)
        .set({
          status: "failed",
          blockReason: null,
          retryCount: nextRetryCount,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      if (reworkTask) {
        await recordEvent({
          type: "task.split",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: "needs_rework",
            reworkTaskId: reworkTask.id,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Created rework task ${reworkTask.id} from blocked task ${task.id}`);
      }
      handled++;
      continue;
    }

    if (reason === "awaiting_judge") {
      if (await hasPendingJudgeRun(task.id)) {
        // Judge未処理の成功Runが残っている間は再実行しない
        continue;
      }
      const recoveredRunId = await restoreLatestJudgeRun(task.id);
      if (recoveredRunId) {
        await db
          .update(tasks)
          .set({
            status: "blocked",
            blockReason: "awaiting_judge",
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: "awaiting_judge_run_restored",
            runId: recoveredRunId,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Restored awaiting_judge run for task: ${task.id}`);
        handled++;
        continue;
      }
    }

    await db
      .update(tasks)
      .set({
        status: "queued",
        blockReason: null,
        retryCount: nextRetryCount,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    await recordEvent({
      type: "task.requeued",
      entityType: "task",
      entityId: task.id,
      payload: {
        reason:
          reason === "awaiting_judge"
            ? "awaiting_judge_timeout_retry"
            : reason === "quota_wait"
              ? "quota_wait_retry"
              : "blocked_cooldown_retry",
        cooldownMs: requiredCooldownMs,
        retryAt: new Date(retryAtMs).toISOString(),
        retryCount: nextRetryCount,
      },
    });
    console.log(`[Cleanup] Requeued blocked task: ${task.id}`);
    handled++;
  }

  return handled;
}
