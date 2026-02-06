import { Queue, Worker, Job, QueueEvents } from "bullmq";

// タスク実行キュー
export const TASK_QUEUE_NAME = "sebastian-code-tasks";
// デッドレターキュー（最終的に失敗したジョブ用）
export const DEAD_LETTER_QUEUE_NAME = "sebastian-code-dead-letter";

// Redis接続設定（URLベース）
const getConnectionConfig = () => {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
};

// タスクジョブデータ
export interface TaskJobData {
  taskId: string;
  agentId: string;
  priority: number;
}

// エージェント専用のキュー名を生成
export function getTaskQueueName(agentId?: string): string {
  if (!agentId) return TASK_QUEUE_NAME;
  return `${TASK_QUEUE_NAME}-${agentId}`;
}

// タスクキューを作成
export function createTaskQueue(queueName = TASK_QUEUE_NAME): Queue<TaskJobData> {
  return new Queue(queueName, {
    connection: getConnectionConfig(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: {
        count: 1000,
        age: 24 * 60 * 60, // 24時間
      },
      removeOnFail: {
        count: 5000,
        age: 7 * 24 * 60 * 60, // 7日間
      },
    },
  });
}

// タスクワーカーを作成
export function createTaskWorker(
  processor: (job: Job<TaskJobData>) => Promise<void>,
  queueName = TASK_QUEUE_NAME
): Worker<TaskJobData> {
  // タスクが長時間実行される可能性があるため、lockDurationを十分長く設定する
  const maxTaskTimeoutSeconds = parseInt(process.env.TASK_TIMEOUT_SECONDS ?? "3600", 10);
  const lockDurationMs = (maxTaskTimeoutSeconds + 600) * 1000; // タイムアウト + 10分のバッファ
  
  return new Worker(queueName, processor, {
    connection: getConnectionConfig(),
    concurrency: parseInt(process.env.MAX_CONCURRENT_WORKERS ?? "5", 10),
    lockDuration: lockDurationMs, // ジョブのロック期間を延長してstalled判定を防ぐ
  });
}

// タスクをキューに追加
export async function enqueueTask(
  queue: Queue<TaskJobData>,
  data: TaskJobData
): Promise<Job<TaskJobData>> {
  return queue.add(`task:${data.taskId}`, data, {
    priority: data.priority,
  });
}

// ジョブ状態を取得
export async function getJobState(
  queue: Queue<TaskJobData>,
  jobId: string
): Promise<string | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return job.getState();
}

// キュー統計を取得
export async function getQueueStats(queue: Queue<TaskJobData>) {
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    total: waiting + active + completed + failed,
  };
}

// デッドレターキューを作成
export function createDeadLetterQueue(): Queue<TaskJobData> {
  return new Queue(DEAD_LETTER_QUEUE_NAME, {
    connection: getConnectionConfig(),
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

// 失敗ジョブをデッドレターキューに移動
export async function moveToDeadLetter(
  job: Job<TaskJobData>,
  deadLetterQueue: Queue<TaskJobData>,
  reason: string
): Promise<void> {
  await deadLetterQueue.add(`dead:${job.data.taskId}`, job.data, {
    priority: 0,
    attempts: 0,
  });

  console.log(
    `[Queue] Moved job ${job.id} to dead letter queue: ${reason}`
  );
}

// 失敗ジョブを再キューイング
export async function requeueFailedJob(
  queue: Queue<TaskJobData>,
  jobId: string,
  options?: {
    priority?: number;
    delay?: number;
  }
): Promise<Job<TaskJobData> | null> {
  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  // 元のジョブデータで新しいジョブを作成
  const newJob = await queue.add(`retry:${job.data.taskId}`, job.data, {
    priority: options?.priority ?? job.data.priority,
    delay: options?.delay ?? 0,
  });

  // 古いジョブを削除
  await job.remove();

  console.log(
    `[Queue] Requeued failed job ${jobId} as ${newJob.id}`
  );

  return newJob;
}

// 失敗ジョブを一括で再キューイング
export async function requeueAllFailedJobs(
  queue: Queue<TaskJobData>
): Promise<number> {
  const failedJobs = await queue.getFailed();
  let requeuedCount = 0;

  for (const job of failedJobs) {
    if (job.id) {
      await requeueFailedJob(queue, job.id);
      requeuedCount++;
    }
  }

  return requeuedCount;
}

// キューイベントを監視
export function createQueueEvents(queueName = TASK_QUEUE_NAME): QueueEvents {
  return new QueueEvents(queueName, {
    connection: getConnectionConfig(),
  });
}

// 失敗ジョブ監視コールバック
export interface FailedJobHandler {
  onFailed: (
    jobId: string,
    failedReason: string,
    attemptsMade: number,
    maxAttempts: number
  ) => Promise<void> | void;
  onDeadLetter: (jobId: string, data: TaskJobData) => Promise<void> | void;
}

// 失敗ジョブ監視を開始
export function startFailedJobMonitor(
  queueEvents: QueueEvents,
  handler: FailedJobHandler,
  queue: Queue<TaskJobData>,
  deadLetterQueue?: Queue<TaskJobData>
): void {
  queueEvents.on("failed", async ({ jobId, failedReason }) => {
    const job = await queue.getJob(jobId);
    if (!job) return;

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 3;

    await handler.onFailed(jobId, failedReason, attemptsMade, maxAttempts);

    // 最大リトライ回数に達した場合、デッドレターキューに移動
    if (attemptsMade >= maxAttempts && deadLetterQueue) {
      await moveToDeadLetter(job, deadLetterQueue, failedReason);
      await handler.onDeadLetter(jobId, job.data);
    }
  });

  console.log("[Queue] Failed job monitor started");
}

// 優先度でジョブを並べ替え
export async function reprioritizeJobs(
  queue: Queue<TaskJobData>,
  priorityFn: (data: TaskJobData) => number
): Promise<number> {
  const waitingJobs = await queue.getWaiting();
  let updatedCount = 0;

  for (const job of waitingJobs) {
    const newPriority = priorityFn(job.data);
    if (newPriority !== job.data.priority) {
      // ジョブを削除して新しい優先度で再追加
      await job.remove();
      await queue.add(job.name ?? `task:${job.data.taskId}`, {
        ...job.data,
        priority: newPriority,
      }, {
        priority: newPriority,
      });
      updatedCount++;
    }
  }

  return updatedCount;
}

// 古い失敗ジョブを削除
export async function cleanOldFailedJobs(
  queue: Queue<TaskJobData>,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000 // 7日
): Promise<number> {
  const failedJobs = await queue.getFailed();
  const now = Date.now();
  let removedCount = 0;

  for (const job of failedJobs) {
    const finishedOn = job.finishedOn;
    if (finishedOn && now - finishedOn > maxAgeMs) {
      await job.remove();
      removedCount++;
    }
  }

  return removedCount;
}

// すべてのキューを削除（DB Cleanup時に利用）
export async function obliterateAllQueues(): Promise<number> {
  const connection = getConnectionConfig();
  let removedCount = 0;

  // 全エージェント用のキューを削除
  const agentRoles = ["worker", "tester", "docser"];
  const maxAgents = 10;

  for (const role of agentRoles) {
    for (let i = 1; i <= maxAgents; i++) {
      const agentId = `${role}-${i}`;
      const queueName = getTaskQueueName(agentId);
      try {
        const queue = new Queue(queueName, { connection });
        await queue.obliterate({ force: true });
        removedCount++;
      } catch (error) {
        // キューが存在しない場合はスキップ
      }
    }
  }

  // 共通キューも削除
  try {
    const mainQueue = new Queue(TASK_QUEUE_NAME, { connection });
    await mainQueue.obliterate({ force: true });
    removedCount++;
  } catch {
    // スキップ
  }

  try {
    const deadLetterQueue = new Queue(DEAD_LETTER_QUEUE_NAME, { connection });
    await deadLetterQueue.obliterate({ force: true });
    removedCount++;
  } catch {
    // スキップ
  }

  return removedCount;
}
