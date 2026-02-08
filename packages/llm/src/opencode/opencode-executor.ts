import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOpenCodeTokenUsage } from "./parse";
import type { OpenCodeOptions, OpenCodeResult } from "./opencode-types";
import { buildOpenCodePrompt } from "./opencode-prompt";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MODEL,
  DOOM_LOOP_IDENTICAL_THRESHOLD,
  DOOM_LOOP_WINDOW,
  EXTERNAL_PERMISSION_HINTS,
  EXTERNAL_PERMISSION_PROMPT,
  IDLE_CHECK_INTERVAL_MS,
  MAX_CONSECUTIVE_PLANNING_LINES,
  PARENT_SHUTDOWN_SIGNALS,
  PROGRESS_LOG_INTERVAL_MS,
} from "./opencode-constants";
import {
  hasRepeatedPattern,
  isQuotaExceededError,
  normalizeChunkLine,
  normalizeForPromptDetection,
} from "./opencode-helpers";

export async function executeOpenCodeOnce(
  options: OpenCodeOptions
): Promise<Omit<OpenCodeResult, "retryCount">> {
  const startTime = Date.now();
  const resolvedIdleTimeoutSeconds = Number.isFinite(DEFAULT_IDLE_TIMEOUT_SECONDS)
    && DEFAULT_IDLE_TIMEOUT_SECONDS > 0
    ? DEFAULT_IDLE_TIMEOUT_SECONDS
    : 900;
  const idleTimeoutMs = Math.min(
    options.timeoutSeconds * 1000,
    resolvedIdleTimeoutSeconds * 1000
  );
  const idleTimeoutEnabled = idleTimeoutMs > 0;
  let lastOutputAt = startTime;
  let lastVisibleProgressAt = startTime;
  const args: string[] = ["run"];
  const tempDir = await mkdtemp(join(tmpdir(), "openTiger-opencode-"));
  const promptPath = join(tempDir, "prompt.txt");

  // Pass prompt via file to avoid CLI argument limits and parsing issues
  const prompt = await buildOpenCodePrompt(options);
  await writeFile(promptPath, prompt, "utf-8");

  const model = options.model ?? DEFAULT_MODEL;
  if (model) {
    args.push("--model", model);
  }

  // Output fatal errors from opencode to stderr so they can be detected
  args.push("--print-logs", "--log-level", "ERROR");
  args.push("--file", promptPath);
  args.push("--");
  args.push("Read the attached prompt and follow the instructions.");

  const baseEnv = options.inheritEnv === false ? {} : globalThis.process.env;
  const useProcessGroup = process.platform !== "win32";
  const childProcess = spawn("opencode", args, {
    cwd: options.workdir,
    env: {
      ...baseEnv,
      ...options.env,
    },
    // Enable process group termination to prevent child processes from lingering
    detached: useProcessGroup,
    timeout: options.timeoutSeconds * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutSeconds * 1000;
  let timedOut = false;
  let idleTimedOut = false;
  let quotaExceeded = false;
  let permissionPromptBlocked = false;
  let printedErrorSummary = false;
  const parentSignalHandlers: Array<{ signal: NodeJS.Signals; listener: () => void }> = [];
  const MAX_ERROR_SUMMARY_LENGTH = 240;
  const terminateOpenCode = (signal: NodeJS.Signals): void => {
    const pid = childProcess.pid;
    if (!pid) {
      try {
        childProcess.kill(signal);
      } catch {
        // Ignore if already terminated
      }
      return;
    }
    if (useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // If process group termination fails, kill the PID directly
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already terminated
    }
  };
  const registerParentSignalHandlers = (): void => {
    for (const signal of PARENT_SHUTDOWN_SIGNALS) {
      const listener = () => {
        stderr += `\n[OpenCode] Parent process received ${signal}. Terminating child process`;
        terminateOpenCode("SIGTERM");
        setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
      };
      process.once(signal, listener);
      parentSignalHandlers.push({ signal, listener });
    }
  };
  const unregisterParentSignalHandlers = (): void => {
    for (const { signal, listener } of parentSignalHandlers) {
      process.off(signal, listener);
    }
    parentSignalHandlers.length = 0;
  };
  registerParentSignalHandlers();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateOpenCode("SIGTERM");
    setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
  }, timeoutMs);
  const idleWatchdog = setInterval(() => {
    if (!idleTimeoutEnabled) {
      return;
    }
    const idleMs = Date.now() - lastVisibleProgressAt;
    if (idleMs >= idleTimeoutMs && !idleTimedOut) {
      idleTimedOut = true;
      process.stderr.write(
        `\n[OpenCode] Idle timeout exceeded (${Math.round(idleTimeoutMs / 1000)}s without visible progress)\n`
      );
      terminateOpenCode("SIGTERM");
      setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
    }
  }, IDLE_CHECK_INTERVAL_MS);
  const progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const idleSec = Math.round((Date.now() - lastVisibleProgressAt) / 1000);
    process.stdout.write(
      `[OpenCode] Running... elapsed=${elapsed}s idle=${idleSec}s\n`
    );
  }, PROGRESS_LOG_INTERVAL_MS);

  let stdout = "";
  let stderr = "";
  let doomLoopDetected = false;
  const recentChunks: string[] = [];
  let consecutivePlanningLines = 0;
  const markDoomLoopAndTerminate = (): void => {
    if (doomLoopDetected) {
      return;
    }
    doomLoopDetected = true;
    process.stderr.write("\n[OpenCode] Doom loop detected. Forcing termination.\n");
    terminateOpenCode("SIGTERM");
    setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
  };

  const pushChunkAndDetectDoomLoop = (line: string): void => {
    if (doomLoopDetected) {
      return;
    }
    const normalized = normalizeChunkLine(line);
    if (normalized.length <= 10) {
      return;
    }
    recentChunks.push(normalized);
    if (recentChunks.length > DOOM_LOOP_WINDOW) {
      recentChunks.shift();
    }

    if (recentChunks.length >= DOOM_LOOP_IDENTICAL_THRESHOLD) {
      const last = recentChunks[recentChunks.length - 1];
      const repeats = recentChunks.filter((chunk) => chunk === last).length;
      if (repeats >= DOOM_LOOP_IDENTICAL_THRESHOLD) {
        markDoomLoopAndTerminate();
        return;
      }
    }

    if (hasRepeatedPattern(recentChunks)) {
      markDoomLoopAndTerminate();
    }
  };

  const isPlanningLine = (line: string): boolean => {
    const normalized = line.trim().toLowerCase();
    return (
      normalized.startsWith("i will ") ||
      normalized.startsWith("i'll ") ||
      normalized.startsWith("i am going to ") ||
      normalized.startsWith("let me ")
    );
  };

  const detectPermissionPrompt = (chunk: string): void => {
    if (permissionPromptBlocked) {
      return;
    }
    const normalizedChunk = normalizeForPromptDetection(chunk);
    const hasPromptHint = normalizedChunk.includes("external_directory")
      && EXTERNAL_PERMISSION_HINTS.some((hint) => normalizedChunk.includes(hint));
    if (!EXTERNAL_PERMISSION_PROMPT.test(normalizedChunk) && !hasPromptHint) {
      return;
    }

    permissionPromptBlocked = true;
    stderr +=
      "\n[OpenCode] Non-interactive run blocked by external_directory permission prompt";
    process.stderr.write(
      "\n[OpenCode] external_directory permission prompt detected. Aborting non-interactive run.\n"
    );
    terminateOpenCode("SIGTERM");
    setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
  };

  childProcess.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    lastOutputAt = Date.now();
    lastVisibleProgressAt = Date.now();
    detectPermissionPrompt(chunk);
    // Output logs in real-time
    process.stdout.write(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      pushChunkAndDetectDoomLoop(line);
      if (/\[tool_call:\s*todo(?:read|write)\b/i.test(line)) {
        stderr += "\n[OpenCode] Unsupported pseudo tool call detected: todo*";
        markDoomLoopAndTerminate();
        continue;
      }
      if (
        /\[tool_call:\s*bash\b/i.test(line)
        && /\b(?:pnpm|npm|yarn|bun)\b.*\b(?:dev|watch|start)\b/i.test(line)
      ) {
        stderr += "\n[OpenCode] Long-running dev/watch/start command detected in tool call";
        markDoomLoopAndTerminate();
        continue;
      }
      if (isPlanningLine(line)) {
        consecutivePlanningLines += 1;
        if (consecutivePlanningLines >= MAX_CONSECUTIVE_PLANNING_LINES) {
          stderr += `\n[OpenCode] Excessive planning chatter detected (${consecutivePlanningLines} lines)`;
          markDoomLoopAndTerminate();
          continue;
        }
      } else if (line.trim().length > 0) {
        consecutivePlanningLines = 0;
      }
    }
  });

  childProcess.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    lastOutputAt = Date.now();
    detectPermissionPrompt(chunk);
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      if (!quotaExceeded && isQuotaExceededError(line)) {
        quotaExceeded = true;
        // Quota exceeded won't recover, so stop early
        process.stderr.write("\n[OpenCode] Quota limit reached. Aborting.\n");
        terminateOpenCode("SIGTERM");
        setTimeout(() => terminateOpenCode("SIGKILL"), 2000);
        continue;
      }
      if (!printedErrorSummary && (line.startsWith("ERROR") || line.includes(" error="))) {
        printedErrorSummary = true;
        const summary =
          line.length > MAX_ERROR_SUMMARY_LENGTH
            ? `${line.slice(0, MAX_ERROR_SUMMARY_LENGTH)}...`
            : line;
        process.stderr.write(`${summary}\n`);
        lastVisibleProgressAt = Date.now();
      }
    }
  });

  return new Promise((resolve) => {
    let settled = false;
    let settleGuard: ReturnType<typeof setInterval> | null = null;
    const settle = (result: Omit<OpenCodeResult, "retryCount">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(idleWatchdog);
      clearInterval(progressTimer);
      if (settleGuard) {
        clearInterval(settleGuard);
      }
      unregisterParentSignalHandlers();
      rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      resolve(result);
    };

    const buildResult = (code: number | null): Omit<OpenCodeResult, "retryCount"> => {
      const durationMs = Date.now() - startTime;
      const tokenUsage = extractOpenCodeTokenUsage(stdout);
      const timeoutMessage = timedOut ? "\n[OpenCode] Timeout exceeded" : "";
      const idleTimeoutMessage = idleTimedOut
        ? `\n[OpenCode] Idle timeout exceeded (${Math.round(idleTimeoutMs / 1000)}s without visible progress)`
        : "";
      const quotaMessage = quotaExceeded ? "\n[OpenCode] Quota limit reached" : "";
      const doomLoopMessage = doomLoopDetected ? "\n[OpenCode] Doom loop detected" : "";
      const permissionPromptMessage = permissionPromptBlocked
        ? "\n[OpenCode] external_directory permission prompt blocked the run"
        : "";

      return {
        success:
          !timedOut
          && !idleTimedOut
          && !quotaExceeded
          && !doomLoopDetected
          && !permissionPromptBlocked
          && code === 0,
        exitCode:
          timedOut
          || idleTimedOut
          || quotaExceeded
          || doomLoopDetected
          || permissionPromptBlocked
            ? -1
            : code ?? -1,
        stdout,
        stderr:
          stderr
          + timeoutMessage
          + idleTimeoutMessage
          + quotaMessage
          + doomLoopMessage
          + permissionPromptMessage,
        durationMs,
        tokenUsage,
      };
    };

    childProcess.on("close", (code) => {
      settle(buildResult(code));
    });

    childProcess.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      // Fallback for missed close events
      if (signal) {
        stderr += `\n[OpenCode] Process exited by signal: ${signal}`;
      }
      settle(buildResult(code));
    });

    childProcess.on("error", (error) => {
      const durationMs = Date.now() - startTime;
      settle({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + error.message,
        durationMs,
      });
    });

    // Absorb rare environment differences where close/exit events are missed
    settleGuard = setInterval(() => {
      if (settled) {
        return;
      }
      if (childProcess.exitCode !== null) {
        settle(buildResult(childProcess.exitCode));
      }
    }, 1000);
  });
}
