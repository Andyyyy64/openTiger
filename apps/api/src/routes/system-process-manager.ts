import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@openTiger/db";
import {
  agents,
  leases,
  runs,
  tasks,
} from "@openTiger/db/schema";
import { configToEnv } from "../system-config.js";
import { ensureConfigRow } from "../config-store.js";
import { getAuthInfo } from "../middleware/index.js";
import { buildPreflightSummary } from "./system-preflight.js";
import { canControlSystem } from "./system-auth.js";
import {
  resolveRepoRoot,
  resolveRequirementPath,
  writeRequirementFile,
} from "./system-requirements.js";

type RestartStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  message?: string;
};

type ProcessStatus = "idle" | "running" | "completed" | "failed" | "stopped";
type ProcessKind = "service" | "worker" | "planner" | "database" | "command";

type ProcessInfo = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
};

type ProcessRuntime = {
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
  process?: ChildProcess | null;
  stopRequested?: boolean;
  lastPayload?: StartPayload;
  restartAttempts?: number;
  restartWindowStartedAt?: number;
  restartScheduled?: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
};

type StartPayload = {
  requirementPath?: string;
  content?: string;
};

type StartCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ProcessDefinition = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  autoRestart?: boolean;
  buildStart: (payload: StartPayload) => Promise<StartCommand>;
};

let restartProcess: ChildProcess | null = null;
let restartStatus: RestartStatus = { status: "idle" };
const managedProcesses = new Map<string, ProcessRuntime>();
const processStartPromises = new Map<string, Promise<ProcessInfo>>();
const processStartLocks = new Set<string>();
const AUTO_RESTART_ENABLED = process.env.SYSTEM_PROCESS_AUTO_RESTART !== "false";
const AUTO_RESTART_DELAY_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS ?? "2000",
  10
);
const AUTO_RESTART_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS ?? "300000",
  10
);
const AUTO_RESTART_MAX_ATTEMPTS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS ?? "-1",
  10
);

function resolveLogDir(): string {
  if (process.env.OPENTIGER_LOG_DIR) {
    return process.env.OPENTIGER_LOG_DIR;
  }
  if (process.env.OPENTIGER_RAW_LOG_DIR) {
    return process.env.OPENTIGER_RAW_LOG_DIR;
  }
  return join(resolveRepoRoot(), "raw-logs");
}

function describeCommand(command: StartCommand): string {
  return [command.command, ...command.args].join(" ");
}

const MAX_PLANNER_PROCESSES = 1;
const AGENT_LIVENESS_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_AGENT_LIVENESS_WINDOW_MS ?? "120000",
  10
);

function resolveBoundAgentId(processName: string): string | null {
  if (processName === "planner") {
    return "planner-1";
  }
  if (processName === "judge") {
    return "judge-1";
  }
  if (/^(judge|worker|tester|docser)-\d+$/.test(processName)) {
    return processName;
  }
  return null;
}

async function detectLiveBoundAgent(processName: string): Promise<{
  alive: boolean;
  agentId?: string;
  lastHeartbeat?: string;
}> {
  const agentId = resolveBoundAgentId(processName);
  if (!agentId) {
    return { alive: false };
  }

  const [agent] = await db
    .select({
      id: agents.id,
      status: agents.status,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent?.lastHeartbeat) {
    return { alive: false, agentId };
  }

  const livenessWindowMs = Number.isFinite(AGENT_LIVENESS_WINDOW_MS)
    && AGENT_LIVENESS_WINDOW_MS > 0
    ? AGENT_LIVENESS_WINDOW_MS
    : 120000;
  const alive =
    agent.status !== "offline"
    && agent.lastHeartbeat.getTime() >= Date.now() - livenessWindowMs;

  return {
    alive,
    agentId,
    lastHeartbeat: agent.lastHeartbeat.toISOString(),
  };
}

function parseIndexedProcessName(
  name: string,
  prefix: string,
  options: { allowBaseName?: boolean } = {}
): number | null {
  const allowBaseName = options.allowBaseName ?? false;
  if (allowBaseName && name === prefix) {
    return 1;
  }
  const match = name.match(new RegExp(`^${prefix}-(\\d+)$`));
  if (!match?.[1]) {
    return null;
  }
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index <= 0) {
    return null;
  }
  return index;
}

function buildPlannerDefinition(index: number): ProcessDefinition {
  return {
    name: "planner",
    label: "Planner",
    description: "requirementsからタスクを生成",
    group: "Planner",
    kind: "planner",
    supportsStop: true,
    buildStart: async (payload) => {
      const requirementPath = await resolveRequirementPath(
        payload.requirementPath,
        "requirement.md",
        { allowMissing: Boolean(payload.content) }
      );
      if (payload.content) {
        await writeRequirementFile(requirementPath, payload.content);
      }
      return {
        command: "pnpm",
        args: ["--filter", "@openTiger/planner", "run", "start:fresh", requirementPath],
        cwd: resolveRepoRoot(),
        env: { AGENT_ID: `planner-${index}` },
      };
    },
  };
}

function buildJudgeDefinition(index: number): ProcessDefinition {
  const name = index === 1 ? "judge" : `judge-${index}`;
  return {
    name,
    label: index === 1 ? "Judge" : `Judge #${index}`,
    description: "レビュー判定の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/judge", "start"],
      cwd: resolveRepoRoot(),
      env: { AGENT_ID: `judge-${index}` },
    }),
  };
}

function buildWorkerRoleDefinition(
  role: "worker" | "tester" | "docser",
  index: number
): ProcessDefinition {
  const name = `${role}-${index}`;
  const label = role === "docser"
    ? (index === 1 ? "Docser" : `Docser #${index}`)
    : `${role === "worker" ? "Worker" : "Tester"} #${index}`;
  const description = role === "worker"
    ? "実装ワーカー"
    : role === "tester"
      ? "テスト専用ワーカー"
      : "ドキュメント更新ワーカー";
  return {
    name,
    label,
    description,
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/worker", "start"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: String(index), AGENT_ROLE: role },
    }),
  };
}

function resolveDynamicProcessDefinition(name: string): ProcessDefinition | undefined {
  const judgeIndex = parseIndexedProcessName(name, "judge", { allowBaseName: true });
  if (judgeIndex !== null) {
    return buildJudgeDefinition(judgeIndex);
  }

  const workerIndex = parseIndexedProcessName(name, "worker");
  if (workerIndex !== null) {
    return buildWorkerRoleDefinition("worker", workerIndex);
  }

  const testerIndex = parseIndexedProcessName(name, "tester");
  if (testerIndex !== null) {
    return buildWorkerRoleDefinition("tester", testerIndex);
  }

  const docserIndex = parseIndexedProcessName(name, "docser");
  if (docserIndex !== null) {
    return buildWorkerRoleDefinition("docser", docserIndex);
  }

  return undefined;
}

const processDefinitions: ProcessDefinition[] = [
  buildPlannerDefinition(MAX_PLANNER_PROCESSES),
  {
    name: "dispatcher",
    label: "Dispatcher",
    description: "タスク割当の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/dispatcher", "start"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "cycle-manager",
    label: "Cycle Manager",
    description: "長時間運用の管理プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/cycle-manager", "run", "start:fresh"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-up",
    label: "Database Start",
    description: "Postgres/Redisを起動",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "up", "-d", "postgres", "redis"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-down",
    label: "Database Stop",
    description: "Postgres/Redisを停止",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "down"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-push",
    label: "Database Push",
    description: "スキーマを反映",
    group: "Database",
    kind: "command",
    supportsStop: false,
    buildStart: async () => ({
      command: "pnpm",
      args: ["db:push"],
      cwd: resolveRepoRoot(),
    }),
  },
];

const processDefinitionMap = new Map(
  processDefinitions.map((definition) => [definition.name, definition])
);

function resolveProcessDefinition(name: string): ProcessDefinition | undefined {
  return processDefinitionMap.get(name) ?? resolveDynamicProcessDefinition(name);
}

function listProcessDefinitions(): ProcessDefinition[] {
  const definitions = new Map<string, ProcessDefinition>();
  for (const definition of processDefinitions) {
    definitions.set(definition.name, definition);
  }

  for (const processName of managedProcesses.keys()) {
    if (definitions.has(processName)) {
      continue;
    }
    const dynamic = resolveDynamicProcessDefinition(processName);
    if (dynamic) {
      definitions.set(dynamic.name, dynamic);
    }
  }

  return Array.from(definitions.values());
}

function buildProcessInfo(
  definition: ProcessDefinition,
  runtime?: ProcessRuntime
): ProcessInfo {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    group: definition.group,
    kind: definition.kind,
    supportsStop: definition.supportsStop,
    status: runtime?.status ?? "idle",
    startedAt: runtime?.startedAt,
    finishedAt: runtime?.finishedAt,
    pid: runtime?.pid,
    exitCode: runtime?.exitCode,
    signal: runtime?.signal ? String(runtime.signal) : undefined,
    logPath: runtime?.logPath,
    message: runtime?.message,
    lastCommand: runtime?.lastCommand,
  };
}

function canAutoRestart(definition: ProcessDefinition, runtime: ProcessRuntime): boolean {
  if (!AUTO_RESTART_ENABLED) {
    return false;
  }
  if (!definition.autoRestart) {
    return false;
  }
  if (runtime.stopRequested) {
    return false;
  }
  return true;
}

async function scheduleProcessAutoRestart(
  definition: ProcessDefinition,
  runtime: ProcessRuntime
): Promise<void> {
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
  }

  const now = Date.now();
  const windowMs = Number.isFinite(AUTO_RESTART_WINDOW_MS) && AUTO_RESTART_WINDOW_MS > 0
    ? AUTO_RESTART_WINDOW_MS
    : 300000;
  const delayMs = Number.isFinite(AUTO_RESTART_DELAY_MS) && AUTO_RESTART_DELAY_MS >= 0
    ? AUTO_RESTART_DELAY_MS
    : 2000;
  const hasMaxAttempts = Number.isFinite(AUTO_RESTART_MAX_ATTEMPTS)
    && AUTO_RESTART_MAX_ATTEMPTS > 0;
  const maxAttempts = hasMaxAttempts ? AUTO_RESTART_MAX_ATTEMPTS : Number.POSITIVE_INFINITY;

  const windowStart = runtime.restartWindowStartedAt ?? now;
  const resetWindow = now - windowStart > windowMs;
  const nextAttempts = (resetWindow ? 0 : (runtime.restartAttempts ?? 0)) + 1;
  const nextWindowStart = resetWindow ? now : windowStart;
  const cappedAttemptsForBackoff = Math.max(1, Math.min(nextAttempts, 6));
  const nextDelayMs = Math.min(60000, delayMs * (2 ** (cappedAttemptsForBackoff - 1)));
  const attemptLabel = hasMaxAttempts ? `${nextAttempts}/${maxAttempts}` : `${nextAttempts}/∞`;

  if (hasMaxAttempts && nextAttempts > maxAttempts) {
    managedProcesses.set(definition.name, {
      ...runtime,
      restartAttempts: nextAttempts,
      restartWindowStartedAt: nextWindowStart,
      restartScheduled: false,
      message: `Auto-restart exhausted (${maxAttempts}/${Math.round(windowMs / 1000)}s)`,
    });
    console.error(
      `[System] Auto-restart exhausted for ${definition.name} (attempts=${nextAttempts})`
    );
    return;
  }

  managedProcesses.set(definition.name, {
    ...runtime,
    restartAttempts: nextAttempts,
    restartWindowStartedAt: nextWindowStart,
    restartScheduled: true,
    restartTimer: undefined,
    message: `Auto-restart scheduled (${attemptLabel}, delay=${nextDelayMs}ms)`,
  });

  const restartTimer = setTimeout(async () => {
    const latest = managedProcesses.get(definition.name);
    if (!latest) {
      return;
    }
    const latestWithoutTimer: ProcessRuntime = {
      ...latest,
      restartTimer: undefined,
    };
    managedProcesses.set(definition.name, latestWithoutTimer);
    if (latestWithoutTimer.stopRequested || latestWithoutTimer.status === "running") {
      managedProcesses.set(definition.name, {
        ...latestWithoutTimer,
        restartScheduled: false,
        restartTimer: undefined,
      });
      return;
    }

    try {
      await startManagedProcess(definition, latestWithoutTimer.lastPayload ?? {});
      const refreshed = managedProcesses.get(definition.name);
      if (refreshed) {
        managedProcesses.set(definition.name, {
          ...refreshed,
          restartScheduled: false,
          restartTimer: undefined,
          message: `Auto-restarted (${attemptLabel})`,
        });
      }
      console.log(`[System] Auto-restarted process: ${definition.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = managedProcesses.get(definition.name);
      if (updated) {
        managedProcesses.set(definition.name, {
          ...updated,
          restartScheduled: false,
          restartTimer: undefined,
          message: `Auto-restart failed: ${message}`,
        });
      }
      console.error(`[System] Auto-restart failed for ${definition.name}: ${message}`);
    }
  }, nextDelayMs);
  if (typeof restartTimer.unref === "function") {
    restartTimer.unref();
  }
  const updated = managedProcesses.get(definition.name);
  if (updated) {
    managedProcesses.set(definition.name, {
      ...updated,
      restartTimer,
    });
  }
}

async function startManagedProcess(
  definition: ProcessDefinition,
  payload: StartPayload
): Promise<ProcessInfo> {
  const inFlightStart = processStartPromises.get(definition.name);
  if (inFlightStart) {
    return inFlightStart;
  }

  const startPromise = (async () => {
    const existing = managedProcesses.get(definition.name);
    if (existing?.status === "running") {
      return buildProcessInfo(definition, existing);
    }
    if (existing?.restartTimer) {
      clearTimeout(existing.restartTimer);
      managedProcesses.set(definition.name, {
        ...existing,
        restartTimer: undefined,
        restartScheduled: false,
      });
    }

    const configRow = await ensureConfigRow();
    const configEnv = configToEnv(configRow);
    const command = await definition.buildStart(payload);
    const startedAt = new Date().toISOString();
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `system-${definition.name}-${Date.now()}.log`);
    const logStream = createWriteStream(logPath, { flags: "a" });

    const child = spawn(command.command, command.args, {
      cwd: command.cwd ?? resolveRepoRoot(),
      env: {
        ...process.env,
        ...configEnv,
        ...command.env,
        OPENTIGER_LOG_DIR: logDir,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Stream logs to file for tracking
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    const runtime: ProcessRuntime = {
      status: "running",
      startedAt,
      pid: child.pid,
      logPath,
      lastCommand: describeCommand(command),
      process: child,
      stopRequested: false,
      lastPayload: payload,
      restartScheduled: false,
      restartTimer: undefined,
      restartAttempts: existing?.restartAttempts,
      restartWindowStartedAt: existing?.restartWindowStartedAt,
    };
    managedProcesses.set(definition.name, runtime);

    // Update state when process exits
    child.on("exit", (code, signal) => {
      const latest = managedProcesses.get(definition.name);
      if (!latest) return;
      const status = latest.stopRequested
        ? "stopped"
        : code === 0
          ? "completed"
          : "failed";
      const nextRuntime: ProcessRuntime = {
        ...latest,
        status,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        process: null,
      };
      managedProcesses.set(definition.name, nextRuntime);
      logStream.end();

      if (canAutoRestart(definition, nextRuntime)) {
        void scheduleProcessAutoRestart(definition, nextRuntime);
      }
    });

    child.on("error", (error) => {
      const latest = managedProcesses.get(definition.name);
      if (!latest) return;
      const nextRuntime: ProcessRuntime = {
        ...latest,
        status: "failed",
        finishedAt: new Date().toISOString(),
        message: error.message,
        process: null,
      };
      managedProcesses.set(definition.name, nextRuntime);
      logStream.end();

      if (canAutoRestart(definition, nextRuntime)) {
        void scheduleProcessAutoRestart(definition, nextRuntime);
      }
    });

    child.unref();
    return buildProcessInfo(definition, runtime);
  })();

  processStartPromises.set(definition.name, startPromise);
  try {
    return await startPromise;
  } finally {
    if (processStartPromises.get(definition.name) === startPromise) {
      processStartPromises.delete(definition.name);
    }
  }
}

function stopManagedProcess(
  definition: ProcessDefinition
): ProcessInfo {
  const runtime = managedProcesses.get(definition.name);
  if (!runtime) {
    return buildProcessInfo(definition, { status: "idle" });
  }
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
  }
  if (runtime.status !== "running" || !runtime.process) {
    const nextRuntime: ProcessRuntime = {
      ...runtime,
      stopRequested: true,
      restartScheduled: false,
      restartTimer: undefined,
      message: "停止要求済み",
    };
    managedProcesses.set(definition.name, nextRuntime);
    return buildProcessInfo(definition, nextRuntime);
  }

  runtime.stopRequested = true;
  runtime.restartScheduled = false;
  runtime.restartTimer = undefined;
  runtime.message = "停止要求済み";
  managedProcesses.set(definition.name, runtime);

  const processRef = runtime.process;
  const pid = runtime.pid ?? processRef.pid;

  function killRuntime(signal: NodeJS.Signals): void {
    if (!pid) {
      processRef.kill(signal);
      return;
    }

    // Processes started with detached become a new process group,
    // so kill the entire group to prevent pnpm/tsx child processes from lingering
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fallback: kill individual PID
      }
    }

    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already terminated
    }
  }

  // Reflect stop request first, termination is confirmed by event
  killRuntime("SIGTERM");
  setTimeout(() => {
    killRuntime("SIGKILL");
  }, 5000);

  return buildProcessInfo(definition, runtime);
}

function startRestart(): RestartStatus {
  const startedAt = new Date().toISOString();
  const logDir = resolveLogDir();
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `system-restart-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const child = spawn("pnpm", ["run", "restart"], {
    cwd: resolveRepoRoot(),
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Stream logs to file for tracking
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  restartProcess = child;
  restartStatus = {
    status: "running",
    startedAt,
    logPath,
  };

  child.on("exit", (code, signal) => {
    restartStatus = {
      ...restartStatus,
      status: code === 0 ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
    };
    restartProcess = null;
    logStream.end();
  });

  child.on("error", (error) => {
    restartStatus = {
      ...restartStatus,
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: error.message,
    };
    restartProcess = null;
    logStream.end();
  });

  child.unref();
  return restartStatus;
}

export function registerProcessManagerRoutes(systemRoute: Hono): void {
  systemRoute.get("/restart", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json(restartStatus);
  });

  systemRoute.post("/restart", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    if (restartProcess) {
      return c.json(
        {
          error: "Restart already running",
          status: restartStatus,
        },
        409,
      );
    }

    try {
      const status = startRestart();
      return c.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restart";
      restartStatus = { status: "failed", message };
      restartProcess = null;
      return c.json({ error: message }, 500);
    }
  });

  systemRoute.get("/processes", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const processes = listProcessDefinitions().map((definition) =>
      buildProcessInfo(definition, managedProcesses.get(definition.name))
    );
    return c.json({ processes });
  });

  systemRoute.get("/processes/:name", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }
    const info = buildProcessInfo(definition, managedProcesses.get(definition.name));
    return c.json({ process: info });
  });

  systemRoute.post("/processes/:name/start", async (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }

    const discoveredAgent = await detectLiveBoundAgent(name);
    if (discoveredAgent.alive) {
      const existingRuntime = managedProcesses.get(definition.name);
      const runtime: ProcessRuntime = {
        ...(existingRuntime ?? { status: "running" as const }),
        status: "running",
        finishedAt: undefined,
        exitCode: null,
        signal: null,
        stopRequested: false,
        message:
          `Detected existing live agent ${discoveredAgent.agentId}` +
          (discoveredAgent.lastHeartbeat
            ? ` (heartbeat=${discoveredAgent.lastHeartbeat})`
            : ""),
      };
      managedProcesses.set(definition.name, runtime);
      return c.json({
        process: buildProcessInfo(definition, runtime),
        alreadyRunning: true,
        discovered: true,
      });
    }

    const runtimeKey = definition.name;
    const existing = managedProcesses.get(runtimeKey);
    const shouldRejectDuplicateStart = definition.kind === "planner";
    if (shouldRejectDuplicateStart) {
      // Planner tends to save multiple plans from the same requirement when started multiple times, so exclude duplicate start requests
      if (existing?.status === "running") {
        return c.json(
          {
            error: "Planner already running",
            process: buildProcessInfo(definition, existing),
          },
          409
        );
      }
      if (processStartLocks.has(runtimeKey)) {
        return c.json(
          {
            error: "Planner start already in progress",
            process: buildProcessInfo(definition, managedProcesses.get(runtimeKey)),
          },
          409
        );
      }
      processStartLocks.add(runtimeKey);
    } else if (existing?.status === "running") {
      return c.json({
        process: buildProcessInfo(definition, existing),
        alreadyRunning: true,
      });
    }

    try {
      const rawBody = await c.req.json().catch(() => ({}));
      const rawContent = typeof rawBody?.content === "string" ? rawBody.content : undefined;
      if (rawContent !== undefined && rawContent.trim().length === 0) {
        return c.json({ error: "Requirement content is empty" }, 400);
      }
      if (definition.kind === "planner") {
        const configRow = await ensureConfigRow();
        const preflight = await buildPreflightSummary({
          configRow,
          autoCreateIssueTasks: false,
          autoCreatePrJudgeTasks: false,
        });
        const hasJudgeBacklog =
          preflight.github.openPrCount > 0 || preflight.local.pendingJudgeTaskCount > 0;
        if (hasJudgeBacklog) {
          return c.json(
            {
              error:
                `Planner start blocked: pending PR/judge backlog exists ` +
                `(openPR=${preflight.github.openPrCount}, awaitingJudge=${preflight.local.pendingJudgeTaskCount}). ` +
                "Start judge first and clear PR backlog.",
            },
            409
          );
        }
      }
      const payload: StartPayload = {
        requirementPath:
          typeof rawBody?.requirementPath === "string"
            ? rawBody.requirementPath
            : undefined,
        content: rawContent,
      };
      const processInfo = await startManagedProcess(definition, payload);
      return c.json({ process: processInfo });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start process";
      return c.json({ error: message }, 400);
    } finally {
      if (shouldRejectDuplicateStart) {
        processStartLocks.delete(runtimeKey);
      }
    }
  });

  systemRoute.post("/processes/:name/stop", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }

    if (!definition.supportsStop) {
      return c.json({ error: "Process cannot be stopped" }, 400);
    }

    const info = stopManagedProcess(definition);
    return c.json({ process: info });
  });

  systemRoute.post("/processes/stop-all", async (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const stopped: string[] = [];
    const skipped: string[] = [];

    for (const definition of listProcessDefinitions()) {
      // Only stop processes other than ui and server
      // ui and server are started by pnpm run up and are not managed by system.ts
      if (definition.name === "ui" || definition.name === "server" || definition.name === "dashboard" || definition.name === "api") {
        continue;
      }

      if (!definition.supportsStop) {
        skipped.push(definition.name);
        continue;
      }

      const runtime = managedProcesses.get(definition.name);
      if (runtime) {
        stopManagedProcess(definition);
        stopped.push(definition.name);
      } else {
        skipped.push(definition.name);
      }
    }

    let cancelledRuns = 0;
    let requeuedTasks = 0;
    try {
      const runningRows = await db
        .select({
          runId: runs.id,
          taskId: runs.taskId,
        })
        .from(runs)
        .where(eq(runs.status, "running"));

      if (runningRows.length > 0) {
        const runningRunIds = runningRows.map((row) => row.runId);
        const runningTaskIds = Array.from(new Set(runningRows.map((row) => row.taskId)));

        cancelledRuns = runningRunIds.length;
        requeuedTasks = runningTaskIds.length;

        await db
          .update(runs)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            errorMessage: "System stop-all requested",
          })
          .where(inArray(runs.id, runningRunIds));

        await db
          .update(tasks)
          .set({
            status: "queued",
            blockReason: null,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.status, "running"), inArray(tasks.id, runningTaskIds)));

        await db.delete(leases).where(inArray(leases.taskId, runningTaskIds));
      }

      await db
        .update(agents)
        .set({
          status: "offline",
          currentTaskId: null,
          lastHeartbeat: new Date(),
        })
        .where(
          inArray(
            agents.role,
            ["planner", "judge", "worker", "tester", "docser", "dispatcher", "cycle-manager"]
          )
        );
    } catch (error) {
      console.error("[System] stop-all cleanup failed:", error);
    }

    return c.json({
      stopped,
      skipped,
      cancelledRuns,
      requeuedTasks,
      message: `Stopped ${stopped.length} process(es)`,
    });
  });
}
