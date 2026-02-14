import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { buildTaskEnv } from "../../env";
import { DEV_COMMAND_WARMUP_MS, DEV_PORT_IN_USE_PATTERNS } from "./constants";
import { parseCommand } from "./command-parser";
import type { CommandResult } from "./types";

function isInsidePath(basePath: string, candidatePath: string): boolean {
  const normalizedBase = resolve(basePath);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}/`) ||
    normalizedCandidate.startsWith(`${normalizedBase}\\`)
  );
}

function normalizePathEntry(entry: string): string {
  return entry.replace(/\\/g, "/");
}

function isNodeModulesBinPath(entry: string): boolean {
  const normalized = normalizePathEntry(entry).replace(/\/+$/, "");
  return normalized.endsWith("/node_modules/.bin");
}

export function buildCommandPath(cwd: string, currentPath: string | undefined): string {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const preferredEntry = join(cwd, "node_modules", ".bin");
  const rawEntries = (currentPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const filteredEntries = rawEntries.filter((entry) => {
    if (!isNodeModulesBinPath(entry)) {
      return true;
    }
    return isInsidePath(cwd, entry);
  });
  const uniqueEntries = Array.from(new Set([preferredEntry, ...filteredEntries]));
  return uniqueEntries.join(delimiter);
}

// Execute command
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 300000,
): Promise<CommandResult> {
  const startTime = Date.now();
  const baseEnv = await buildTaskEnv(cwd);
  const parsed = parseCommand(command);
  if (!parsed) {
    return {
      command,
      success: false,
      outcome: "failed",
      stdout: "",
      stderr: "Unsupported command format. Shell operators are not allowed.",
      durationMs: Date.now() - startTime,
    };
  }
  const env = {
    ...baseEnv,
    ...parsed.env,
  };
  env.PATH = buildCommandPath(cwd, env.PATH);

  return new Promise((resolve) => {
    const process = spawn(parsed.executable, parsed.args, {
      cwd,
      timeout: timeoutMs,
      env,
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      const success = code === 0;
      resolve({
        command,
        success,
        outcome: success ? "passed" : "failed",
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    process.on("error", (error) => {
      resolve({
        command,
        success: false,
        outcome: "failed",
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

function buildPortOverrideCommand(command: string, port: number): string | null {
  if (/\s--port\b/.test(command)) {
    return null;
  }
  const parsed = parseCommand(command);
  if (parsed?.args.includes("run")) {
    return `${command} -- --port ${port}`;
  }
  return `${command} --port ${port}`;
}

// Detect Vite "port in use" errors and start on fallback port
function shouldRetryDevWithPort(stderr: string): boolean {
  return DEV_PORT_IN_USE_PATTERNS.some((pattern) => pattern.test(stderr));
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Failed to acquire an available port"));
      }
    });
  });
}

async function runDevCommandOnce(
  command: string,
  cwd: string,
  warmupMs = DEV_COMMAND_WARMUP_MS,
): Promise<CommandResult> {
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const baseEnv = await buildTaskEnv(cwd);
  const parsed = parseCommand(command);
  if (!parsed) {
    return {
      command,
      success: false,
      outcome: "failed",
      stdout,
      stderr: "Unsupported command format. Shell operators are not allowed.",
      durationMs: Date.now() - startTime,
    };
  }
  const env = {
    ...baseEnv,
    ...parsed.env,
  };
  env.PATH = buildCommandPath(cwd, env.PATH);

  return new Promise((resolve) => {
    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      detached: true,
      env,
    });
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          globalThis.process.kill(-child.pid, signal);
          return;
        } catch {
          // Kill single process as fallback
        }
      }
      child.kill(signal);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 2000);
    }, warmupMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const success = timedOut ? true : code === 0;
      resolve({
        command,
        success,
        outcome: success ? "passed" : "failed",
        stdout: timedOut ? `${stdout}\n[dev-check] warmup completed, process terminated` : stdout,
        stderr,
        durationMs,
      });
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      resolve({
        command,
        success: false,
        outcome: "failed",
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// dev is long-running; only verify short startup
export async function runDevCommand(
  command: string,
  cwd: string,
  warmupMs = DEV_COMMAND_WARMUP_MS,
): Promise<CommandResult> {
  const result = await runDevCommandOnce(command, cwd, warmupMs);
  if (!result.success && shouldRetryDevWithPort(result.stderr)) {
    try {
      const port = await findAvailablePort();
      const override = buildPortOverrideCommand(command, port);
      if (override) {
        const retryResult = await runDevCommandOnce(override, cwd, warmupMs);
        if (retryResult.success) {
          return {
            ...retryResult,
            stdout: `${retryResult.stdout}\n[dev-check] port override: ${port}`,
          };
        }
        return retryResult;
      }
    } catch {
      return result;
    }
  }
  return result;
}
