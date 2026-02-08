import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "../system-requirements";
import { resolveLogDir } from "./helpers";
import { restartState } from "./state";
import type { RestartStatus } from "./types";

// 再起動コマンドは独立プロセスとして走らせる
export function startRestart(): RestartStatus {
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

  restartState.process = child;
  restartState.status = {
    status: "running",
    startedAt,
    logPath,
  };

  child.on("exit", (code, signal) => {
    restartState.status = {
      ...restartState.status,
      status: code === 0 ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
    };
    restartState.process = null;
    logStream.end();
  });

  child.on("error", (error) => {
    restartState.status = {
      ...restartState.status,
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: error.message,
    };
    restartState.process = null;
    logStream.end();
  });

  child.unref();
  return restartState.status;
}
