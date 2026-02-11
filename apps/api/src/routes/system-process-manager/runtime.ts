import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configToEnv } from "../../system-config";
import { ensureConfigRow } from "../../config-store";
import { resolveRepoRoot } from "../system-requirements";
import { describeCommand, resolveLogDir } from "./helpers";
import { managedProcesses, processStartPromises } from "./state";
import type { ProcessDefinition, ProcessInfo, ProcessRuntime, StartPayload } from "./types";

// Process start/stop and auto-restart orchestration
const AUTO_RESTART_ENABLED = process.env.SYSTEM_PROCESS_AUTO_RESTART !== "false";
const AUTO_RESTART_DELAY_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS ?? "2000",
  10,
);
const AUTO_RESTART_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS ?? "300000",
  10,
);
const AUTO_RESTART_MAX_ATTEMPTS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS ?? "-1",
  10,
);

const SYSTEM_PROCESS_CMD_PATTERNS: RegExp[] = [
  /\bpnpm\s+--filter\s+@openTiger\/dispatcher\s+start\b/i,
  /\bpnpm\s+--filter\s+@openTiger\/cycle-manager\s+run\s+start\b/i,
  /\bpnpm\s+--filter\s+@openTiger\/judge\s+start\b/i,
  /\bpnpm\s+--filter\s+@openTiger\/worker\s+run\s+start\b/i,
  /\bpnpm\s+--filter\s+@openTiger\/planner\s+run\s+start\b/i,
];

type OsProcessInfo = {
  pid: number;
  command: string;
};

type ForceStopSummary = {
  matched: number;
  signaled: number;
  killed: number;
  pids: number[];
};

type LaunchMode = "process" | "docker";

function resolveExecutionEnvironment(rawValue: string | undefined): "host" | "sandbox" {
  return rawValue?.trim().toLowerCase() === "sandbox" ? "sandbox" : "host";
}

function resolveLaunchMode(executionEnvironment: "host" | "sandbox"): LaunchMode {
  return executionEnvironment === "sandbox" ? "docker" : "process";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to single process kill
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Ignore if already gone
  }
}

async function listOsProcesses(): Promise<OsProcessInfo[]> {
  if (process.platform === "win32") {
    return [];
  }

  return await new Promise<OsProcessInfo[]>((resolve) => {
    const ps = spawn("ps", ["-eo", "pid=,args="], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    ps.stdout?.setEncoding("utf-8");
    ps.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    ps.on("close", () => {
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const processes: OsProcessInfo[] = [];
      for (const row of rows) {
        const match = row.match(/^(\d+)\s+(.+)$/);
        if (!match?.[1] || !match[2]) {
          continue;
        }
        const pid = Number.parseInt(match[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) {
          continue;
        }
        processes.push({
          pid,
          command: match[2],
        });
      }
      resolve(processes);
    });

    ps.on("error", () => {
      resolve([]);
    });
  });
}

export async function forceTerminateUnmanagedSystemProcesses(): Promise<ForceStopSummary> {
  const processes = await listOsProcesses();
  if (processes.length === 0) {
    return { matched: 0, signaled: 0, killed: 0, pids: [] };
  }

  const currentPid = process.pid;
  const targetPids = Array.from(
    new Set(
      processes
        .filter((row) => row.pid !== currentPid)
        .filter((row) => SYSTEM_PROCESS_CMD_PATTERNS.some((pattern) => pattern.test(row.command)))
        .map((row) => row.pid),
    ),
  );

  if (targetPids.length === 0) {
    return { matched: 0, signaled: 0, killed: 0, pids: [] };
  }

  for (const pid of targetPids) {
    killPidGroup(pid, "SIGTERM");
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  let killed = 0;
  for (const pid of targetPids) {
    if (!isPidAlive(pid)) {
      continue;
    }
    killPidGroup(pid, "SIGKILL");
    killed += 1;
  }

  return {
    matched: targetPids.length,
    signaled: targetPids.length,
    killed,
    pids: targetPids,
  };
}

export function buildProcessInfo(
  definition: ProcessDefinition,
  runtime?: ProcessRuntime,
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
  runtime: ProcessRuntime,
): Promise<void> {
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
  }

  const now = Date.now();
  const windowMs =
    Number.isFinite(AUTO_RESTART_WINDOW_MS) && AUTO_RESTART_WINDOW_MS > 0
      ? AUTO_RESTART_WINDOW_MS
      : 300000;
  const delayMs =
    Number.isFinite(AUTO_RESTART_DELAY_MS) && AUTO_RESTART_DELAY_MS >= 0
      ? AUTO_RESTART_DELAY_MS
      : 2000;
  const hasMaxAttempts =
    Number.isFinite(AUTO_RESTART_MAX_ATTEMPTS) && AUTO_RESTART_MAX_ATTEMPTS > 0;
  const maxAttempts = hasMaxAttempts ? AUTO_RESTART_MAX_ATTEMPTS : Number.POSITIVE_INFINITY;

  const windowStart = runtime.restartWindowStartedAt ?? now;
  const resetWindow = now - windowStart > windowMs;
  const nextAttempts = (resetWindow ? 0 : (runtime.restartAttempts ?? 0)) + 1;
  const nextWindowStart = resetWindow ? now : windowStart;
  const cappedAttemptsForBackoff = Math.max(1, Math.min(nextAttempts, 6));
  const nextDelayMs = Math.min(60000, delayMs * 2 ** (cappedAttemptsForBackoff - 1));
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
      `[System] Auto-restart exhausted for ${definition.name} (attempts=${nextAttempts})`,
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

export async function startManagedProcess(
  definition: ProcessDefinition,
  payload: StartPayload,
): Promise<ProcessInfo> {
  const inFlightStart = processStartPromises.get(definition.name);
  if (inFlightStart) {
    return inFlightStart;
  }

  const startPromise = (async () => {
    const existing = managedProcesses.get(definition.name);
    if (existing?.status === "running" && existing.process) {
      return buildProcessInfo(definition, existing);
    }
    if (existing?.status === "running" && !existing.process) {
      // Managed state can remain "running" when process was discovered externally.
      // Treat it as stale and allow explicit restart.
      managedProcesses.set(definition.name, {
        ...existing,
        status: "stopped",
        finishedAt: new Date().toISOString(),
        restartScheduled: false,
        restartTimer: undefined,
        message: "Recovered stale runtime state before restart",
      });
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
    const executionEnvironment = resolveExecutionEnvironment(configEnv.EXECUTION_ENVIRONMENT);
    const launchMode = resolveLaunchMode(executionEnvironment);
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
        // Apply executor selector value to launcher config at start
        EXECUTION_ENVIRONMENT: executionEnvironment,
        LAUNCH_MODE: launchMode,
        OPENTIGER_LOG_DIR: logDir,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Stream system-managed process stdout to file and parent terminal for monitoring
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });

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
      const status = latest.stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
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

export function stopManagedProcess(definition: ProcessDefinition): ProcessInfo {
  const runtime = managedProcesses.get(definition.name);
  if (!runtime) {
    return buildProcessInfo(definition, { status: "idle" });
  }
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
  }
  if (runtime.status !== "running") {
    const nextRuntime: ProcessRuntime = {
      ...runtime,
      stopRequested: true,
      restartScheduled: false,
      restartTimer: undefined,
      message: "Stop requested",
    };
    managedProcesses.set(definition.name, nextRuntime);
    return buildProcessInfo(definition, nextRuntime);
  }

  if (!runtime.process) {
    // External/discovered runtime without process handle cannot be signaled.
    // Mark as stopped so a new start can recreate the process.
    const nextRuntime: ProcessRuntime = {
      ...runtime,
      status: "stopped",
      finishedAt: new Date().toISOString(),
      stopRequested: true,
      restartScheduled: false,
      restartTimer: undefined,
      message: "Stopped (managed process not connected)",
    };
    managedProcesses.set(definition.name, nextRuntime);
    return buildProcessInfo(definition, nextRuntime);
  }

  runtime.stopRequested = true;
  runtime.restartScheduled = false;
  runtime.restartTimer = undefined;
  runtime.message = "Stop requested";
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
