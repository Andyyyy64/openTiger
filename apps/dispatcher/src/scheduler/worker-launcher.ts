import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";

// Worker launch mode
export type LaunchMode = "process" | "docker";

// Worker launch config
export interface WorkerLaunchConfig {
  mode: LaunchMode;
  taskId: string;
  agentId: string;
  agentRole?: string;
  repoUrl: string;
  baseBranch: string;
  workspacePath: string;
  // Docker settings
  dockerImage?: string;
  dockerNetwork?: string;
  // Environment variables
  env?: Record<string, string>;
}

// Worker launch result
export interface LaunchResult {
  success: boolean;
  pid?: number;
  containerId?: string;
  error?: string;
}

// Manage active Worker processes
const activeWorkers = new Map<
  string,
  { process?: ChildProcess; containerId?: string; agentId: string }
>();
const DEFAULT_OPENCODE_CONFIG_PATH = resolve(import.meta.dirname, "../../../../opencode.json");
const DEFAULT_DOCKER_IMAGE = "openTiger/worker:latest";
const DEFAULT_DOCKER_NETWORK = "bridge";
const DEFAULT_HOST_LOG_DIR = resolve(import.meta.dirname, "../../../../raw-logs");
const DOCKER_WORKER_LOG_DIR = "/tmp/openTiger-logs";

type DockerMount = {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
};

function resolveDockerImage(config: WorkerLaunchConfig): string {
  return config.dockerImage ?? process.env.SANDBOX_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
}

function resolveDockerNetwork(config: WorkerLaunchConfig): string {
  return config.dockerNetwork ?? process.env.SANDBOX_DOCKER_NETWORK ?? DEFAULT_DOCKER_NETWORK;
}

function isLocalhostHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function rewriteLocalUrlForDocker(rawValue: string | undefined): string {
  if (!rawValue) {
    return "";
  }
  try {
    const parsed = new URL(rawValue);
    if (!isLocalhostHost(parsed.hostname)) {
      return rawValue;
    }
    parsed.hostname = "host.docker.internal";
    return parsed.toString();
  } catch {
    return rawValue;
  }
}

function resolveClaudeAuthMounts(): DockerMount[] {
  const hostHome = process.env.HOME?.trim();
  const claudeHomeOverride = process.env.CLAUDE_AUTH_DIR?.trim();
  const claudeConfigOverride = process.env.CLAUDE_CONFIG_DIR?.trim();
  const candidates: Array<DockerMount | null> = [
    claudeHomeOverride
      ? {
          hostPath: resolve(claudeHomeOverride),
          containerPath: "/home/worker/.claude",
          readonly: true,
        }
      : null,
    claudeConfigOverride
      ? {
          hostPath: resolve(claudeConfigOverride),
          containerPath: "/home/worker/.config/claude",
          readonly: true,
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".claude"),
          containerPath: "/home/worker/.claude",
          readonly: true,
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".config", "claude"),
          containerPath: "/home/worker/.config/claude",
          readonly: true,
        }
      : null,
  ];

  const mounts: DockerMount[] = [];
  const seenContainerPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (seenContainerPaths.has(candidate.containerPath)) {
      continue;
    }
    if (!existsSync(candidate.hostPath)) {
      continue;
    }
    mounts.push(candidate);
    seenContainerPaths.add(candidate.containerPath);
  }
  return mounts;
}

function resolveCodexAuthMounts(): DockerMount[] {
  const hostHome = process.env.HOME?.trim();
  const codexAuthOverride = process.env.CODEX_AUTH_DIR?.trim();
  const candidates: Array<DockerMount | null> = [
    codexAuthOverride
      ? {
          hostPath: resolve(codexAuthOverride),
          containerPath: "/home/worker/.codex",
          readonly: true,
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".codex"),
          containerPath: "/home/worker/.codex",
          readonly: true,
        }
      : null,
  ];

  const mounts: DockerMount[] = [];
  const seenContainerPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (seenContainerPaths.has(candidate.containerPath)) {
      continue;
    }
    if (!existsSync(candidate.hostPath)) {
      continue;
    }
    mounts.push(candidate);
    seenContainerPaths.add(candidate.containerPath);
  }
  return mounts;
}

function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "openai_codex" || normalized === "openai-codex";
}

// Launch Worker as process
async function _launchAsProcess(config: WorkerLaunchConfig): Promise<LaunchResult> {
  const env = {
    ...process.env,
    TASK_ID: config.taskId,
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.agentRole ?? "worker",
    REPO_URL: config.repoUrl,
    BASE_BRANCH: config.baseBranch,
    WORKSPACE_PATH: config.workspacePath,
    REPO_MODE: process.env.REPO_MODE,
    LOCAL_REPO_PATH: process.env.LOCAL_REPO_PATH,
    LOCAL_WORKTREE_ROOT: process.env.LOCAL_WORKTREE_ROOT,
    // Explicitly override/preserve important environment variables
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENCODE_MODEL: process.env.OPENCODE_MODEL,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? DEFAULT_OPENCODE_CONFIG_PATH,
    LLM_EXECUTOR: process.env.LLM_EXECUTOR,
    CLAUDE_CODE_PERMISSION_MODE: process.env.CLAUDE_CODE_PERMISSION_MODE,
    CLAUDE_CODE_MODEL: process.env.CLAUDE_CODE_MODEL,
    CLAUDE_CODE_MAX_TURNS: process.env.CLAUDE_CODE_MAX_TURNS,
    CLAUDE_CODE_ALLOWED_TOOLS: process.env.CLAUDE_CODE_ALLOWED_TOOLS,
    CLAUDE_CODE_DISALLOWED_TOOLS: process.env.CLAUDE_CODE_DISALLOWED_TOOLS,
    CLAUDE_CODE_APPEND_SYSTEM_PROMPT: process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT,
    CODEX_MODEL: process.env.CODEX_MODEL,
    CODEX_MAX_RETRIES: process.env.CODEX_MAX_RETRIES,
    CODEX_RETRY_DELAY_MS: process.env.CODEX_RETRY_DELAY_MS,
    CODEX_ECHO_STDOUT: process.env.CODEX_ECHO_STDOUT,
    CODEX_SKIP_GIT_REPO_CHECK: process.env.CODEX_SKIP_GIT_REPO_CHECK,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ...config.env,
  };

  try {
    console.log(`[Dispatcher] Launching worker process for task ${config.taskId}...`);
    const workerProcess = spawn("pnpm", ["--filter", "@openTiger/worker", "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const pid = workerProcess.pid;

    if (!pid) {
      return { success: false, error: "Failed to get process PID" };
    }

    // Log process output
    workerProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    workerProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    // On-exit handling
    workerProcess.on("exit", (code, signal) => {
      console.log(`[Worker ${config.agentId}] exited with code ${code}, signal ${signal}`);
      activeWorkers.delete(config.taskId);

      // Update agent status
      updateAgentStatus(config.agentId, "idle", null, config.agentRole ?? "worker").catch(
        console.error,
      );
    });

    // Record as active Worker
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

// Launch Worker as Docker container
async function launchAsDocker(config: WorkerLaunchConfig): Promise<LaunchResult> {
  const image = resolveDockerImage(config);
  const network = resolveDockerNetwork(config);
  const hostLogDir = resolve(
    process.env.OPENTIGER_LOG_DIR?.trim() ||
      process.env.OPENTIGER_RAW_LOG_DIR?.trim() ||
      DEFAULT_HOST_LOG_DIR,
  );
  try {
    mkdirSync(hostLogDir, { recursive: true });
  } catch (error) {
    console.warn(`[Dispatcher] Failed to prepare log directory: ${hostLogDir}`, error);
  }

  const envArgs: string[] = [];
  const allEnv = {
    TASK_ID: config.taskId,
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.agentRole ?? "worker",
    REPO_URL: config.repoUrl,
    BASE_BRANCH: config.baseBranch,
    WORKSPACE_PATH: "/workspace",
    REPO_MODE: process.env.REPO_MODE ?? "",
    GITHUB_AUTH_MODE: process.env.GITHUB_AUTH_MODE ?? "",
    LOCAL_REPO_PATH: process.env.LOCAL_REPO_PATH ?? "",
    LOCAL_WORKTREE_ROOT: process.env.LOCAL_WORKTREE_ROOT ?? "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    REDIS_URL: process.env.REDIS_URL ?? "",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    OPENCODE_MODEL: process.env.OPENCODE_MODEL ?? "",
    LLM_EXECUTOR: process.env.LLM_EXECUTOR ?? "",
    CLAUDE_CODE_PERMISSION_MODE: process.env.CLAUDE_CODE_PERMISSION_MODE ?? "",
    CLAUDE_CODE_MODEL: process.env.CLAUDE_CODE_MODEL ?? "",
    CLAUDE_CODE_MAX_TURNS: process.env.CLAUDE_CODE_MAX_TURNS ?? "",
    CLAUDE_CODE_ALLOWED_TOOLS: process.env.CLAUDE_CODE_ALLOWED_TOOLS ?? "",
    CLAUDE_CODE_DISALLOWED_TOOLS: process.env.CLAUDE_CODE_DISALLOWED_TOOLS ?? "",
    CLAUDE_CODE_APPEND_SYSTEM_PROMPT: process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT ?? "",
    CODEX_MODEL: process.env.CODEX_MODEL ?? "",
    CODEX_MAX_RETRIES: process.env.CODEX_MAX_RETRIES ?? "",
    CODEX_RETRY_DELAY_MS: process.env.CODEX_RETRY_DELAY_MS ?? "",
    CODEX_ECHO_STDOUT: process.env.CODEX_ECHO_STDOUT ?? "",
    CODEX_SKIP_GIT_REPO_CHECK: process.env.CODEX_SKIP_GIT_REPO_CHECK ?? "",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
    OPENTIGER_LOG_DIR: DOCKER_WORKER_LOG_DIR,
    ...config.env,
  };
  allEnv.DATABASE_URL = rewriteLocalUrlForDocker(allEnv.DATABASE_URL);
  allEnv.REDIS_URL = rewriteLocalUrlForDocker(allEnv.REDIS_URL);

  for (const [key, value] of Object.entries(allEnv)) {
    if (value) {
      envArgs.push("-e", `${key}=${value}`);
    }
  }

  const mountArgs: string[] = [
    "--add-host",
    "host.docker.internal:host-gateway",
    "--volume",
    `${hostLogDir}:${DOCKER_WORKER_LOG_DIR}`,
  ];
  const claudeAuthMounts = resolveClaudeAuthMounts();
  const codexAuthMounts = resolveCodexAuthMounts();
  for (const mount of claudeAuthMounts) {
    const readonlySuffix = mount.readonly ? ":ro" : "";
    mountArgs.push("--volume", `${mount.hostPath}:${mount.containerPath}${readonlySuffix}`);
  }
  for (const mount of codexAuthMounts) {
    const readonlySuffix = mount.readonly ? ":ro" : "";
    mountArgs.push("--volume", `${mount.hostPath}:${mount.containerPath}${readonlySuffix}`);
  }
  if (
    isClaudeExecutor(allEnv.LLM_EXECUTOR) &&
    claudeAuthMounts.length === 0 &&
    !allEnv.ANTHROPIC_API_KEY
  ) {
    console.warn(
      "[Dispatcher] Claude executor is enabled for sandbox, but no host Claude auth directory was found. " +
        "Run `claude /login` on host or set CLAUDE_AUTH_DIR / CLAUDE_CONFIG_DIR.",
    );
  }
  if (isCodexExecutor(allEnv.LLM_EXECUTOR) && codexAuthMounts.length === 0 && !allEnv.OPENAI_API_KEY) {
    console.warn(
      "[Dispatcher] Codex executor is enabled for sandbox, but no host Codex auth directory was found. " +
        "Run `codex login` on host or set CODEX_AUTH_DIR (or configure OPENAI_API_KEY).",
    );
  }

  const args = [
    "run",
    "--rm",
    "--name",
    `opentiger-worker-${config.agentId}`,
    "--network",
    network,
    ...mountArgs,
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
      // Get container ID (first output is ID)
      if (!containerId && output.length === 64) {
        containerId = output;
      }
    });

    dockerProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Worker ${config.agentId}] ${data.toString().trim()}`);
    });

    dockerProcess.on("exit", (code) => {
      activeWorkers.delete(config.taskId);
      updateAgentStatus(config.agentId, "idle", null, config.agentRole ?? "worker").catch(
        console.error,
      );

      if (code === 0) {
        console.log(`[Worker ${config.agentId}] completed successfully`);
      } else {
        console.error(`[Worker ${config.agentId}] failed with code ${code}`);
      }
    });

    // Determine launch success (check after short wait)
    setTimeout(() => {
      if (dockerProcess.exitCode === null) {
        activeWorkers.set(config.taskId, {
          containerId: `opentiger-worker-${config.agentId}`,
          agentId: config.agentId,
        });
        resolve({ success: true, containerId: `opentiger-worker-${config.agentId}` });
      } else {
        resolve({ success: false, error: "Container exited immediately" });
      }
    }, 1000);
  });
}

// Start Worker
export async function launchWorker(config: WorkerLaunchConfig): Promise<LaunchResult> {
  // Update agent to busy
  await updateAgentStatus(config.agentId, "busy", config.taskId, config.agentRole ?? "worker");

  if (config.mode === "docker") {
    return launchAsDocker(config);
  }

  // Skip new process launch when using resident Worker (queue mode)
  // Assume Worker is already running
  console.log(`[Launcher] Task ${config.taskId} assigned to worker ${config.agentId} via queue.`);
  return { success: true, pid: 0 };
}

// Stop Worker
export async function stopWorker(taskId: string): Promise<boolean> {
  const worker = activeWorkers.get(taskId);
  if (!worker) {
    return false;
  }

  if (worker.process) {
    worker.process.kill("SIGTERM");
    // SIGKILL if still running after 5 seconds
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

// Get active Worker count
export function getActiveWorkerCount(): number {
  return activeWorkers.size;
}

// Get all active Workers
export function getActiveWorkers(): Map<
  string,
  { process?: ChildProcess; containerId?: string; agentId: string }
> {
  return activeWorkers;
}

// Update agent status
async function updateAgentStatus(
  agentId: string,
  status: "idle" | "busy" | "offline",
  currentTaskId: string | null = null,
  role: string = "worker",
): Promise<void> {
  await db
    .insert(agents)
    .values({
      id: agentId,
      role,
      status,
      currentTaskId,
      lastHeartbeat: new Date(),
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        role,
        status,
        currentTaskId,
        lastHeartbeat: new Date(),
      },
    });
}

// Stop all Workers (for shutdown)
export async function stopAllWorkers(): Promise<void> {
  const tasks = Array.from(activeWorkers.keys());
  await Promise.all(tasks.map((taskId) => stopWorker(taskId)));
}
