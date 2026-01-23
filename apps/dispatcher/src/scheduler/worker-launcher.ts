import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { db } from "@h1ve/db";
import { agents } from "@h1ve/db/schema";
import { eq } from "drizzle-orm";

// Worker起動モード
export type LaunchMode = "process" | "docker";

// Worker起動設定
export interface WorkerLaunchConfig {
  mode: LaunchMode;
  taskId: string;
  agentId: string;
  repoUrl: string;
  baseBranch: string;
  workspacePath: string;
  // Docker用設定
  dockerImage?: string;
  dockerNetwork?: string;
  // 環境変数
  env?: Record<string, string>;
}

// Worker起動結果
export interface LaunchResult {
  success: boolean;
  pid?: number;
  containerId?: string;
  error?: string;
}

// アクティブなWorkerプロセスを管理
const activeWorkers = new Map<
  string,
  { process?: ChildProcess; containerId?: string; agentId: string }
>();

// Workerをプロセスとして起動
async function launchAsProcess(
  config: WorkerLaunchConfig
): Promise<LaunchResult> {
  const env = {
    ...process.env,
    TASK_ID: config.taskId,
    AGENT_ID: config.agentId,
    REPO_URL: config.repoUrl,
    BASE_BRANCH: config.baseBranch,
    WORKSPACE_PATH: config.workspacePath,
    // 重要な環境変数を明示的に上書き/保持
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENCODE_MODEL: process.env.OPENCODE_MODEL,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? join(process.cwd(), "../../opencode.json"),
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ...config.env,
  };

  try {
    console.log(`[Dispatcher] Launching worker process for task ${config.taskId}...`);
    const workerProcess = spawn("pnpm", ["--filter", "@h1ve/worker", "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const pid = workerProcess.pid;

    if (!pid) {
      return { success: false, error: "Failed to get process PID" };
    }

    // プロセス出力をログ
    workerProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    workerProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    // 終了時の処理
    workerProcess.on("exit", (code, signal) => {
      console.log(
        `[Worker ${config.agentId}] exited with code ${code}, signal ${signal}`
      );
      activeWorkers.delete(config.taskId);

      // エージェントのステータスを更新
      updateAgentStatus(config.agentId, "idle").catch(console.error);
    });

    // アクティブWorkerとして記録
    activeWorkers.set(config.taskId, {
      process: workerProcess,
      agentId: config.agentId,
    });

    return { success: true, pid };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// WorkerをDockerコンテナとして起動
async function launchAsDocker(
  config: WorkerLaunchConfig
): Promise<LaunchResult> {
  const image = config.dockerImage ?? "h1ve-worker:latest";
  const network = config.dockerNetwork ?? "h1ve_default";

  const envArgs: string[] = [];
  const allEnv = {
    TASK_ID: config.taskId,
    AGENT_ID: config.agentId,
    REPO_URL: config.repoUrl,
    BASE_BRANCH: config.baseBranch,
    WORKSPACE_PATH: "/workspace",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    REDIS_URL: process.env.REDIS_URL ?? "",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    OPENCODE_MODEL: process.env.OPENCODE_MODEL ?? "",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
    ...config.env,
  };

  for (const [key, value] of Object.entries(allEnv)) {
    if (value) {
      envArgs.push("-e", `${key}=${value}`);
    }
  }

  const args = [
    "run",
    "--rm",
    "--name",
    `h1ve-worker-${config.agentId}`,
    "--network",
    network,
    ...envArgs,
    image,
  ];

  return new Promise((resolve) => {
    const dockerProcess = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let containerId = "";

    dockerProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      console.log(`[Worker ${config.agentId}] ${output}`);
      // コンテナIDを取得（最初の出力がID）
      if (!containerId && output.length === 64) {
        containerId = output;
      }
    });

    dockerProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    dockerProcess.on("exit", (code) => {
      activeWorkers.delete(config.taskId);
      updateAgentStatus(config.agentId, "idle").catch(console.error);

      if (code === 0) {
        console.log(`[Worker ${config.agentId}] completed successfully`);
      } else {
        console.error(`[Worker ${config.agentId}] failed with code ${code}`);
      }
    });

    // 起動成功を判定（少し待ってからチェック）
    setTimeout(() => {
      if (dockerProcess.exitCode === null) {
        activeWorkers.set(config.taskId, {
          containerId: `h1ve-worker-${config.agentId}`,
          agentId: config.agentId,
        });
        resolve({ success: true, containerId: `h1ve-worker-${config.agentId}` });
      } else {
        resolve({ success: false, error: "Container exited immediately" });
      }
    }, 1000);
  });
}

// Workerを起動
export async function launchWorker(
  config: WorkerLaunchConfig
): Promise<LaunchResult> {
  // エージェントをbusy状態に更新
  await updateAgentStatus(config.agentId, "busy");

  if (config.mode === "docker") {
    return launchAsDocker(config);
  }
  return launchAsProcess(config);
}

// Workerを停止
export async function stopWorker(taskId: string): Promise<boolean> {
  const worker = activeWorkers.get(taskId);
  if (!worker) {
    return false;
  }

  if (worker.process) {
    worker.process.kill("SIGTERM");
    // 5秒待ってもまだ動いていたらSIGKILL
    setTimeout(() => {
      if (worker.process && !worker.process.killed) {
        worker.process.kill("SIGKILL");
      }
    }, 5000);
  }

  if (worker.containerId) {
    const stopProcess = spawn("docker", ["stop", worker.containerId]);
    await new Promise((resolve) => stopProcess.on("exit", resolve));
  }

  activeWorkers.delete(taskId);
  return true;
}

// アクティブWorker数を取得
export function getActiveWorkerCount(): number {
  return activeWorkers.size;
}

// 全アクティブWorkerを取得
export function getActiveWorkers(): Map<
  string,
  { process?: ChildProcess; containerId?: string; agentId: string }
> {
  return activeWorkers;
}

// エージェントステータスを更新
async function updateAgentStatus(
  agentId: string,
  status: "idle" | "busy" | "offline"
): Promise<void> {
  await db
    .update(agents)
    .set({
      status,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}

// 全Workerを停止（シャットダウン用）
export async function stopAllWorkers(): Promise<void> {
  const tasks = Array.from(activeWorkers.keys());
  await Promise.all(tasks.map((taskId) => stopWorker(taskId)));
}
