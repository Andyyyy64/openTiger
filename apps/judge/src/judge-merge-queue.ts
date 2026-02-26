import { randomUUID } from "node:crypto";
import { db } from "@openTiger/db";
import { artifacts, events, prMergeQueue, tasks } from "@openTiger/db/schema";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { createDocserTaskForPR } from "./docser";
import {
  createConflictAutoFixTaskForPr,
  closeConflictPrAndCreateMainlineTask,
} from "./judge-autofix";
import {
  JUDGE_MERGE_QUEUE_CLAIM_TTL_MS,
  JUDGE_MERGE_QUEUE_MAX_ATTEMPTS,
  JUDGE_MERGE_QUEUE_RETRY_DELAY_MS,
} from "./judge-config";
import { attemptMergeForApprovedPR, type EvaluationSummary } from "./pr-reviewer";

const MERGE_QUEUE_BATCH_LIMIT = 3;

type MergeQueueStatus = "pending" | "processing" | "merged" | "failed" | "cancelled";

type MergeQueueRow = typeof prMergeQueue.$inferSelect;

type QueueLookup = {
  id: string;
  status: MergeQueueStatus;
};

function isUniqueViolationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

async function getActiveQueueByPrNumber(prNumber: number): Promise<QueueLookup | null> {
  const [row] = await db
    .select({ id: prMergeQueue.id, status: prMergeQueue.status })
    .from(prMergeQueue)
    .where(
      and(
        eq(prMergeQueue.prNumber, prNumber),
        inArray(prMergeQueue.status, ["pending", "processing"]),
      ),
    )
    .limit(1);

  if (!row?.id) {
    return null;
  }

  return {
    id: row.id,
    status: row.status as MergeQueueStatus,
  };
}

async function getQueueBySourcePair(taskId: string, runId: string): Promise<QueueLookup | null> {
  const [row] = await db
    .select({ id: prMergeQueue.id, status: prMergeQueue.status })
    .from(prMergeQueue)
    .where(and(eq(prMergeQueue.taskId, taskId), eq(prMergeQueue.runId, runId)))
    .limit(1);

  if (!row?.id) {
    return null;
  }

  return {
    id: row.id,
    status: row.status as MergeQueueStatus,
  };
}

async function recordMergeQueueEvent(params: {
  type:
    | "judge.merge_queue_enqueued"
    | "judge.merge_queue_claim_recovered"
    | "judge.merge_queue_merged"
    | "judge.merge_queue_retried"
    | "judge.merge_queue_failed";
  entityId: string;
  agentId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await db.insert(events).values({
    type: params.type,
    entityType: "task",
    entityId: params.entityId,
    agentId: params.agentId,
    payload: params.payload,
  });
}

function resolveRetryDelayMs(): number {
  if (!Number.isFinite(JUDGE_MERGE_QUEUE_RETRY_DELAY_MS) || JUDGE_MERGE_QUEUE_RETRY_DELAY_MS < 0) {
    return 30_000;
  }
  return JUDGE_MERGE_QUEUE_RETRY_DELAY_MS;
}

function resolveClaimTtlMs(): number {
  if (!Number.isFinite(JUDGE_MERGE_QUEUE_CLAIM_TTL_MS) || JUDGE_MERGE_QUEUE_CLAIM_TTL_MS <= 0) {
    return 120_000;
  }
  return JUDGE_MERGE_QUEUE_CLAIM_TTL_MS;
}

function resolveMaxAttempts(): number {
  if (!Number.isFinite(JUDGE_MERGE_QUEUE_MAX_ATTEMPTS) || JUDGE_MERGE_QUEUE_MAX_ATTEMPTS <= 0) {
    return 3;
  }
  return JUDGE_MERGE_QUEUE_MAX_ATTEMPTS;
}

function buildSyntheticConflictSummary(reason: string): EvaluationSummary {
  return {
    ci: {
      pass: true,
      status: "success",
      reasons: [],
      suggestions: [],
      details: [],
    },
    policy: {
      pass: true,
      reasons: [],
      suggestions: [],
      violations: [],
    },
    llm: {
      pass: false,
      confidence: 0,
      reasons: [reason],
      suggestions: [],
      codeIssues: [],
    },
  };
}

function hasActiveConflictAutoFix(reason: string): boolean {
  return reason.startsWith("existing_active_conflict_autofix:");
}

function hasActiveMainlineRecreate(reason: string): boolean {
  return reason.startsWith("existing_active_mainline_recreate:");
}

type EnqueueMergeQueueParams = {
  prNumber: number;
  taskId: string;
  runId: string;
  priority: number;
  agentId: string;
  reason?: string;
};

type EnqueueMergeQueueResult = {
  enqueued: boolean;
  queueId?: string;
  reason: string;
  existingStatus?: MergeQueueStatus;
};

export async function enqueueMergeQueueItem(
  params: EnqueueMergeQueueParams,
): Promise<EnqueueMergeQueueResult> {
  const existingActive = await getActiveQueueByPrNumber(params.prNumber);
  if (existingActive?.id) {
    return {
      enqueued: false,
      queueId: existingActive.id,
      reason: `existing_active_queue:${existingActive.id}`,
      existingStatus: existingActive.status,
    };
  }

  const existingBySource = await getQueueBySourcePair(params.taskId, params.runId);
  if (existingBySource?.id) {
    return {
      enqueued: false,
      queueId: existingBySource.id,
      reason: `duplicate_source_run:${existingBySource.id}`,
      existingStatus: existingBySource.status,
    };
  }

  const maxAttempts = resolveMaxAttempts();
  let row:
    | {
        id: string;
      }
    | undefined;
  try {
    [row] = await db
      .insert(prMergeQueue)
      .values({
        prNumber: params.prNumber,
        taskId: params.taskId,
        runId: params.runId,
        status: "pending",
        priority: params.priority,
        attemptCount: 0,
        maxAttempts,
        nextAttemptAt: new Date(),
        lastError: params.reason ?? null,
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .returning({ id: prMergeQueue.id });
  } catch (error) {
    if (isUniqueViolationError(error)) {
      const active = await getActiveQueueByPrNumber(params.prNumber);
      if (active?.id) {
        return {
          enqueued: false,
          queueId: active.id,
          reason: `existing_active_queue:${active.id}`,
          existingStatus: active.status,
        };
      }

      const bySource = await getQueueBySourcePair(params.taskId, params.runId);
      if (bySource?.id) {
        return {
          enqueued: false,
          queueId: bySource.id,
          reason: `duplicate_source_run:${bySource.id}`,
          existingStatus: bySource.status,
        };
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    return { enqueued: false, reason: `merge_queue_insert_failed:${detail}` };
  }

  if (!row?.id) {
    return { enqueued: false, reason: "merge_queue_insert_failed" };
  }

  await recordMergeQueueEvent({
    type: "judge.merge_queue_enqueued",
    entityId: params.taskId,
    agentId: params.agentId,
    payload: {
      queueId: row.id,
      prNumber: params.prNumber,
      runId: params.runId,
      reason: params.reason ?? null,
      priority: params.priority,
      maxAttempts,
    },
  });

  return { enqueued: true, queueId: row.id, reason: "enqueued" };
}

async function recoverExpiredClaims(agentId: string): Promise<number> {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + resolveRetryDelayMs());

  const expired = await db
    .select({ id: prMergeQueue.id, taskId: prMergeQueue.taskId, prNumber: prMergeQueue.prNumber })
    .from(prMergeQueue)
    .where(and(eq(prMergeQueue.status, "processing"), lte(prMergeQueue.claimExpiresAt, now)));

  if (expired.length === 0) {
    return 0;
  }

  const ids = expired.map((row) => row.id);
  await db
    .update(prMergeQueue)
    .set({
      status: "pending",
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
      nextAttemptAt,
      updatedAt: now,
    })
    .where(inArray(prMergeQueue.id, ids));

  for (const row of expired) {
    await recordMergeQueueEvent({
      type: "judge.merge_queue_claim_recovered",
      entityId: row.taskId,
      agentId,
      payload: {
        queueId: row.id,
        prNumber: row.prNumber,
      },
    });
  }

  return expired.length;
}

async function renewClaimLease(params: {
  queueId: string;
  claimToken: string;
  agentId: string;
}): Promise<void> {
  const claimTtlMs = resolveClaimTtlMs();
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + claimTtlMs);

  await db
    .update(prMergeQueue)
    .set({
      claimExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(prMergeQueue.id, params.queueId),
        eq(prMergeQueue.status, "processing"),
        eq(prMergeQueue.claimOwner, params.agentId),
        eq(prMergeQueue.claimToken, params.claimToken),
      ),
    );
}

function startClaimHeartbeat(params: {
  queueId: string;
  claimToken: string;
  agentId: string;
}): () => void {
  const intervalMs = Math.max(5_000, Math.floor(resolveClaimTtlMs() / 2));
  const timer = setInterval(() => {
    void renewClaimLease(params).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Judge] Failed to renew merge queue claim lease queue=${params.queueId}: ${reason}`,
      );
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function claimNextPendingQueueItem(agentId: string): Promise<MergeQueueRow | null> {
  const claimTtlMs = resolveClaimTtlMs();
  const now = new Date();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [candidate] = await db
      .select()
      .from(prMergeQueue)
      .where(and(eq(prMergeQueue.status, "pending"), lte(prMergeQueue.nextAttemptAt, now)))
      .orderBy(
        desc(prMergeQueue.priority),
        asc(prMergeQueue.nextAttemptAt),
        asc(prMergeQueue.createdAt),
      )
      .limit(1);
    if (!candidate) {
      return null;
    }

    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + claimTtlMs);
    const [claimed] = await db
      .update(prMergeQueue)
      .set({
        status: "processing",
        claimOwner: agentId,
        claimToken,
        claimedAt: now,
        claimExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(prMergeQueue.id, candidate.id),
          eq(prMergeQueue.status, "pending"),
          lte(prMergeQueue.nextAttemptAt, now),
        ),
      )
      .returning();
    if (claimed) {
      return claimed;
    }
  }

  return null;
}

async function finalizeQueueItem(params: {
  queueId: string;
  claimToken: string;
  agentId: string;
  status: MergeQueueStatus;
  attemptCount?: number;
  nextAttemptAt?: Date;
  lastError?: string | null;
}): Promise<boolean> {
  const updated = await db
    .update(prMergeQueue)
    .set({
      status: params.status,
      attemptCount: params.attemptCount,
      nextAttemptAt: params.nextAttemptAt ?? new Date(),
      lastError: params.lastError,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prMergeQueue.id, params.queueId),
        eq(prMergeQueue.status, "processing"),
        eq(prMergeQueue.claimOwner, params.agentId),
        eq(prMergeQueue.claimToken, params.claimToken),
      ),
    )
    .returning({ id: prMergeQueue.id });

  return updated.length > 0;
}

async function processQueueFailureEscalation(params: {
  queueRow: MergeQueueRow;
  mergeFailureReason: string;
  agentId: string;
}): Promise<void> {
  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      allowedPaths: tasks.allowedPaths,
      commands: tasks.commands,
    })
    .from(tasks)
    .where(eq(tasks.id, params.queueRow.taskId))
    .limit(1);
  if (!task) {
    return;
  }

  const [prArtifact] = await db
    .select({ url: artifacts.url })
    .from(artifacts)
    .where(and(eq(artifacts.runId, params.queueRow.runId), eq(artifacts.type, "pr")))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  const prUrl = prArtifact?.url ?? "";
  const summary = buildSyntheticConflictSummary(params.mergeFailureReason);

  const conflictAutoFix = await createConflictAutoFixTaskForPr({
    prNumber: params.queueRow.prNumber,
    prUrl,
    sourceTaskId: task.id,
    sourceRunId: params.queueRow.runId,
    sourceTaskTitle: task.title,
    sourceTaskGoal: task.goal,
    allowedPaths: task.allowedPaths ?? [],
    commands: task.commands ?? [],
    summary,
    agentId: params.agentId,
    mergeDeferredReason: params.mergeFailureReason,
  });

  if (conflictAutoFix.created || hasActiveConflictAutoFix(conflictAutoFix.reason)) {
    await db
      .update(tasks)
      .set({
        status: "blocked",
        blockReason: "needs_rework",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    return;
  }

  if (!conflictAutoFix.reason.startsWith("conflict_autofix_attempt_limit_reached:")) {
    return;
  }

  const recreate = await closeConflictPrAndCreateMainlineTask({
    prNumber: params.queueRow.prNumber,
    prUrl,
    sourceTaskId: task.id,
    sourceRunId: params.queueRow.runId,
    sourceTaskTitle: task.title,
    sourceTaskGoal: task.goal,
    allowedPaths: task.allowedPaths ?? [],
    commands: task.commands ?? [],
    summary,
    agentId: params.agentId,
    conflictAutoFixReason: conflictAutoFix.reason,
    mergeDeferredReason: params.mergeFailureReason,
  });

  if (recreate.created || hasActiveMainlineRecreate(recreate.reason)) {
    await db
      .update(tasks)
      .set({
        status: "failed",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
  }
}

async function processQueueRow(params: {
  queueRow: MergeQueueRow;
  agentId: string;
  workdir: string;
}): Promise<"merged" | "retry" | "failed"> {
  const claimToken = params.queueRow.claimToken?.trim();
  if (!claimToken) {
    console.warn(`[Judge] Merge queue row ${params.queueRow.id} missing claim token; skipping`);
    return "retry";
  }
  const attemptCount = params.queueRow.attemptCount + 1;
  const mergeResult = await attemptMergeForApprovedPR(params.queueRow.prNumber);
  const mergeFailureReason = mergeResult.mergeDeferredReason ?? "merge_not_completed";

  if (mergeResult.merged) {
    const finalized = await finalizeQueueItem({
      queueId: params.queueRow.id,
      claimToken,
      agentId: params.agentId,
      status: "merged",
      attemptCount,
      lastError: null,
    });
    if (!finalized) {
      console.warn(
        `[Judge] Merge queue row ${params.queueRow.id} claim lost before finalize(merged); skipping`,
      );
      return "retry";
    }
    await db
      .update(tasks)
      .set({
        status: "done",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, params.queueRow.taskId));

    try {
      await createDocserTaskForPR({
        mode: "github",
        prNumber: params.queueRow.prNumber,
        taskId: params.queueRow.taskId,
        runId: params.queueRow.runId,
        agentId: params.agentId,
        workdir: params.workdir,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Judge] Docser creation failed after merge for queue ${params.queueRow.id}: ${reason}`,
      );
    }
    await recordMergeQueueEvent({
      type: "judge.merge_queue_merged",
      entityId: params.queueRow.taskId,
      agentId: params.agentId,
      payload: {
        queueId: params.queueRow.id,
        prNumber: params.queueRow.prNumber,
        runId: params.queueRow.runId,
        attemptCount,
      },
    });
    return "merged";
  }

  if (attemptCount < params.queueRow.maxAttempts) {
    const finalized = await finalizeQueueItem({
      queueId: params.queueRow.id,
      claimToken,
      agentId: params.agentId,
      status: "pending",
      attemptCount,
      nextAttemptAt: new Date(Date.now() + resolveRetryDelayMs()),
      lastError: mergeFailureReason,
    });
    if (!finalized) {
      console.warn(
        `[Judge] Merge queue row ${params.queueRow.id} claim lost before finalize(retry); skipping`,
      );
      return "retry";
    }
    await recordMergeQueueEvent({
      type: "judge.merge_queue_retried",
      entityId: params.queueRow.taskId,
      agentId: params.agentId,
      payload: {
        queueId: params.queueRow.id,
        prNumber: params.queueRow.prNumber,
        runId: params.queueRow.runId,
        attemptCount,
        maxAttempts: params.queueRow.maxAttempts,
        mergeFailureReason,
      },
    });
    return "retry";
  }

  const finalized = await finalizeQueueItem({
    queueId: params.queueRow.id,
    claimToken,
    agentId: params.agentId,
    status: "failed",
    attemptCount,
    lastError: mergeFailureReason,
  });
  if (!finalized) {
    console.warn(
      `[Judge] Merge queue row ${params.queueRow.id} claim lost before finalize(failed); skipping`,
    );
    return "retry";
  }
  await processQueueFailureEscalation({
    queueRow: params.queueRow,
    mergeFailureReason,
    agentId: params.agentId,
  });
  await recordMergeQueueEvent({
    type: "judge.merge_queue_failed",
    entityId: params.queueRow.taskId,
    agentId: params.agentId,
    payload: {
      queueId: params.queueRow.id,
      prNumber: params.queueRow.prNumber,
      runId: params.queueRow.runId,
      attemptCount,
      maxAttempts: params.queueRow.maxAttempts,
      mergeFailureReason,
    },
  });
  return "failed";
}

export async function processMergeQueue(params: { agentId: string; workdir: string }): Promise<{
  recoveredClaims: number;
  processed: number;
  merged: number;
  retried: number;
  failed: number;
}> {
  const recoveredClaims = await recoverExpiredClaims(params.agentId);
  let processed = 0;
  let merged = 0;
  let retried = 0;
  let failed = 0;

  for (let index = 0; index < MERGE_QUEUE_BATCH_LIMIT; index += 1) {
    const queueRow = await claimNextPendingQueueItem(params.agentId);
    if (!queueRow) {
      break;
    }
    if (!queueRow.claimToken) {
      console.warn(`[Judge] Merge queue row ${queueRow.id} claimed without token; skipping`);
      continue;
    }
    const stopHeartbeat = startClaimHeartbeat({
      queueId: queueRow.id,
      claimToken: queueRow.claimToken,
      agentId: params.agentId,
    });

    let outcome: "merged" | "retry" | "failed";
    try {
      outcome = await processQueueRow({
        queueRow,
        agentId: params.agentId,
        workdir: params.workdir,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const attemptCount = queueRow.attemptCount + 1;
      if (attemptCount < queueRow.maxAttempts) {
        const finalized = await finalizeQueueItem({
          queueId: queueRow.id,
          claimToken: queueRow.claimToken,
          agentId: params.agentId,
          status: "pending",
          attemptCount,
          nextAttemptAt: new Date(Date.now() + resolveRetryDelayMs()),
          lastError: reason,
        });
        if (!finalized) {
          console.warn(
            `[Judge] Merge queue row ${queueRow.id} claim lost during exception retry finalize`,
          );
        }
        outcome = "retry";
      } else {
        const finalized = await finalizeQueueItem({
          queueId: queueRow.id,
          claimToken: queueRow.claimToken,
          agentId: params.agentId,
          status: "failed",
          attemptCount,
          lastError: reason,
        });
        if (finalized) {
          await processQueueFailureEscalation({
            queueRow,
            mergeFailureReason: reason,
            agentId: params.agentId,
          });
        } else {
          console.warn(
            `[Judge] Merge queue row ${queueRow.id} claim lost during exception failure finalize`,
          );
        }
        outcome = "failed";
      }
    } finally {
      stopHeartbeat();
    }

    processed += 1;
    if (outcome === "merged") {
      merged += 1;
    } else if (outcome === "retry") {
      retried += 1;
    } else {
      failed += 1;
    }
  }

  return { recoveredClaims, processed, merged, retried, failed };
}

export async function releaseMergeQueueClaimsByOwner(owner: string): Promise<number> {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + resolveRetryDelayMs());
  const released = await db
    .update(prMergeQueue)
    .set({
      status: "pending",
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
      nextAttemptAt,
      updatedAt: now,
    })
    .where(and(eq(prMergeQueue.status, "processing"), eq(prMergeQueue.claimOwner, owner)))
    .returning({ id: prMergeQueue.id });
  return released.length;
}
