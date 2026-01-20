import { Queue, Worker, Job } from "bullmq";

// タスク実行キュー
export const TASK_QUEUE_NAME = "h1ve:tasks";

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

// タスクキューを作成
export function createTaskQueue(): Queue<TaskJobData> {
  return new Queue(TASK_QUEUE_NAME, {
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
  processor: (job: Job<TaskJobData>) => Promise<void>
): Worker<TaskJobData> {
  return new Worker(TASK_QUEUE_NAME, processor, {
    connection: getConnectionConfig(),
    concurrency: parseInt(process.env.MAX_CONCURRENT_WORKERS ?? "5", 10),
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
