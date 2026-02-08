import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { buildTaskEnv } from "../../env";
import { DEV_COMMAND_WARMUP_MS, DEV_PORT_IN_USE_PATTERNS } from "./constants";
import { parseCommand } from "./command-parser";
import type { CommandResult } from "./types";

// コマンドを実行
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
  if (/\b(pnpm|npm|yarn|bun)\b[^\n]*\brun\b/.test(command)) {
    return `${command} -- --port ${port}`;
  }
  if (/^(?:pnpm|npm|yarn|bun)\s+dev\b/.test(command)) {
    return `${command} -- --port ${port}`;
  }
  return `${command} --port ${port}`;
}

// Vite系の「ポート使用中」エラーを検知して退避起動する
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
          // フォールバックで単体プロセスを止める
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

// devは常駐プロセスなので短時間起動だけ確認する
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
