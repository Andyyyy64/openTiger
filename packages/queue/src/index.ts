import { Queue, Worker, Job, QueueEvents } from "bullmq";

// Task execution queue
export const TASK_QUEUE_NAME = "openTiger-tasks";
// Dead letter queue for permanently failed jobs
export const DEAD_LETTER_QUEUE_NAME = "openTiger-dead-letter";

// Redis connection config (URL-based)
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

// Task job data
export interface TaskJobData {
  taskId: string;
  agentId: string;
  priority: number;
}

// Generate agent-specific queue name
export function getTaskQueueName(agentId?: string): string {
  if (!agentId) return TASK_QUEUE_NAME;
  return `${TASK_QUEUE_NAME}-${agentId}`;
}

// Create task queue
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
        age: 24 * 60 * 60, // 24 hours
      },
      removeOnFail: {
        count: 5000,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
}

// Create task worker
export function createTaskWorker(
  processor: (job: Job<TaskJobData>) => Promise<void>,
  queueName = TASK_QUEUE_NAME,
): Worker<TaskJobData> {
  // Shorter lockDuration for faster recovery when process crashes; BullMQ extends lock during normal execution so long tasks can continue
  const configuredLockDurationMs = Number.parseInt(
    process.env.TASK_QUEUE_LOCK_DURATION_MS ?? "120000",
    10,
  );
  const lockDurationMs =
    Number.isFinite(configuredLockDurationMs) && configuredLockDurationMs >= 30000
      ? configuredLockDurationMs
      : 120000;
  const configuredStalledIntervalMs = Number.parseInt(
    process.env.TASK_QUEUE_STALLED_INTERVAL_MS ?? "30000",
    10,
  );
  const stalledIntervalMs =
    Number.isFinite(configuredStalledIntervalMs) && configuredStalledIntervalMs >= 5000
      ? configuredStalledIntervalMs
      : 30000;
  const configuredMaxStalledCount = Number.parseInt(
    process.env.TASK_QUEUE_MAX_STALLED_COUNT ?? "1",
    10,
  );
  const maxStalledCount =
    Number.isFinite(configuredMaxStalledCount) && configuredMaxStalledCount >= 0
      ? configuredMaxStalledCount
      : 1;
  // Single job per agent by default (1 agent = 1 task)
  const configuredConcurrency = Number.parseInt(
    process.env.TASK_QUEUE_WORKER_CONCURRENCY ?? "1",
    10,
  );
  const workerConcurrency =
    Number.isFinite(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 1;

  return new Worker(queueName, processor, {
    connection: getConnectionConfig(),
    concurrency: workerConcurrency,
    lockDuration: lockDurationMs,
    stalledInterval: stalledIntervalMs,
    maxStalledCount,
  });
}

// Enqueue task
export async function enqueueTask(
  queue: Queue<TaskJobData>,
  data: TaskJobData,
): Promise<Job<TaskJobData>> {
  const jobName = `task:${data.taskId}`;
  // Using fixed jobId by taskId blocks requeue while failed/completed jobs exist; add as new job each time
  return await queue.add(jobName, data, {
    priority: data.priority,
  });
}

// Get job state
export async function getJobState(
  queue: Queue<TaskJobData>,
  jobId: string,
): Promise<string | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return job.getState();
}

// Get queue stats
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

// Create dead letter queue
export function createDeadLetterQueue(): Queue<TaskJobData> {
  return new Queue(DEAD_LETTER_QUEUE_NAME, {
    connection: getConnectionConfig(),
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

// Move failed job to dead letter queue
export async function moveToDeadLetter(
  job: Job<TaskJobData>,
  deadLetterQueue: Queue<TaskJobData>,
  reason: string,
): Promise<void> {
  await deadLetterQueue.add(`dead:${job.data.taskId}`, job.data, {
    priority: 0,
    attempts: 0,
  });

  console.log(`[Queue] Moved job ${job.id} to dead letter queue: ${reason}`);
}

// Requeue failed job
export async function requeueFailedJob(
  queue: Queue<TaskJobData>,
  jobId: string,
  options?: {
    priority?: number;
    delay?: number;
  },
): Promise<Job<TaskJobData> | null> {
  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  // Create new job with original job data
  const newJob = await queue.add(`retry:${job.data.taskId}`, job.data, {
    priority: options?.priority ?? job.data.priority,
    delay: options?.delay ?? 0,
  });

  // Remove old job
  await job.remove();

  console.log(`[Queue] Requeued failed job ${jobId} as ${newJob.id}`);

  return newJob;
}

// Bulk requeue failed jobs
export async function requeueAllFailedJobs(queue: Queue<TaskJobData>): Promise<number> {
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

// Monitor queue events
export function createQueueEvents(queueName = TASK_QUEUE_NAME): QueueEvents {
  return new QueueEvents(queueName, {
    connection: getConnectionConfig(),
  });
}

// Failed job monitor callback
export interface FailedJobHandler {
  onFailed: (
    jobId: string,
    failedReason: string,
    attemptsMade: number,
    maxAttempts: number,
  ) => Promise<void> | void;
  onDeadLetter: (jobId: string, data: TaskJobData) => Promise<void> | void;
}

// Start failed job monitor
export function startFailedJobMonitor(
  queueEvents: QueueEvents,
  handler: FailedJobHandler,
  queue: Queue<TaskJobData>,
  deadLetterQueue?: Queue<TaskJobData>,
): void {
  queueEvents.on("failed", async ({ jobId, failedReason }) => {
    const job = await queue.getJob(jobId);
    if (!job) return;

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 3;

    await handler.onFailed(jobId, failedReason, attemptsMade, maxAttempts);

    // Move to dead letter queue when max retries reached
    if (attemptsMade >= maxAttempts && deadLetterQueue) {
      await moveToDeadLetter(job, deadLetterQueue, failedReason);
      await handler.onDeadLetter(jobId, job.data);
    }
  });

  console.log("[Queue] Failed job monitor started");
}

// Reprioritize jobs
export async function reprioritizeJobs(
  queue: Queue<TaskJobData>,
  priorityFn: (data: TaskJobData) => number,
): Promise<number> {
  const waitingJobs = await queue.getWaiting();
  let updatedCount = 0;

  for (const job of waitingJobs) {
    const newPriority = priorityFn(job.data);
    if (newPriority !== job.data.priority) {
      // Remove job and re-add with new priority
      await job.remove();
      await queue.add(
        job.name ?? `task:${job.data.taskId}`,
        {
          ...job.data,
          priority: newPriority,
        },
        {
          priority: newPriority,
        },
      );
      updatedCount++;
    }
  }

  return updatedCount;
}

// Remove old failed jobs
export async function cleanOldFailedJobs(
  queue: Queue<TaskJobData>,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days
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

// Remove all queues (used during DB cleanup)
export async function obliterateAllQueues(): Promise<number> {
  const connection = getConnectionConfig();
  let removedCount = 0;

  // Remove agent queues
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
      } catch {
        // Skip if queue does not exist
      }
    }
  }

  // Remove shared queue as well
  try {
    const mainQueue = new Queue(TASK_QUEUE_NAME, { connection });
    await mainQueue.obliterate({ force: true });
    removedCount++;
  } catch {
    // Skip
  }

  try {
    const deadLetterQueue = new Queue(DEAD_LETTER_QUEUE_NAME, { connection });
    await deadLetterQueue.obliterate({ force: true });
    removedCount++;
  } catch {
    // Skip
  }

  return removedCount;
}
