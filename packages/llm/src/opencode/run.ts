import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { extractOpenCodeTokenUsage, type OpenCodeTokenUsage } from "./parse.js";

// OpenCode実行オプション
export const OpenCodeOptions = z.object({
  // 作業ディレクトリ
  workdir: z.string(),
  // 指示ファイルパス
  instructionsPath: z.string().optional(),
  // タスク内容
  task: z.string(),
  // タイムアウト（秒）
  timeoutSeconds: z.number().int().positive().default(3600),
  // 環境変数
  env: z.record(z.string()).optional(),
  // 既存の環境変数を引き継ぐか
  inheritEnv: z.boolean().optional(),
  // 使用モデル（例: google/gemini-2.0-flash-exp）
  model: z.string().optional(),
  // リトライ設定
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
});
export type OpenCodeOptions = z.infer<typeof OpenCodeOptions>;

// 実行結果
export interface OpenCodeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  tokenUsage?: OpenCodeTokenUsage;
  retryCount: number;
}

// デフォルト設定
const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? "google/gemini-3-flash-preview";
const DEFAULT_FALLBACK_MODEL =
  process.env.OPENCODE_FALLBACK_MODEL ?? "google/gemini-2.5-flash";
const DEFAULT_MAX_RETRIES = parseInt(process.env.OPENCODE_MAX_RETRIES ?? "3", 10);
const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.OPENCODE_RETRY_DELAY_MS ?? "5000", 10);
const DEFAULT_WAIT_ON_QUOTA = process.env.OPENCODE_WAIT_ON_QUOTA !== "false";
const DEFAULT_QUOTA_RETRY_DELAY_MS = parseInt(
  process.env.OPENCODE_QUOTA_RETRY_DELAY_MS ?? "30000",
  10
);
const DEFAULT_MAX_QUOTA_WAITS = parseInt(
  process.env.OPENCODE_MAX_QUOTA_WAITS ?? "-1",
  10
);

const RETRYABLE_ERRORS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /503/,
  /502/,
  /overloaded/i,
  /ETIMEDOUT/,
];

const THOUGHT_SIGNATURE_ERROR = /thought[_\s-]?signature/i;
const QUOTA_EXCEEDED_ERRORS = [
  /quota exceeded/i,
  /exceeded your current quota/i,
  /generate_requests_per_model_per_day/i,
  /resource_exhausted/i,
  /quotafailure/i,
  /retryinfo/i,
  /generate_content_paid_tier_input_token_count/i,
];
const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*m/g;

const DOOM_LOOP_WINDOW = 64;
const DOOM_LOOP_IDENTICAL_THRESHOLD = 5;
const DOOM_LOOP_PATTERN_MAX_LENGTH = 12;
const DOOM_LOOP_PATTERN_REPEAT_THRESHOLD = 4;
const DEFAULT_IDLE_TIMEOUT_SECONDS = parseInt(
  process.env.OPENCODE_IDLE_TIMEOUT_SECONDS ?? "300",
  10
);
const IDLE_CHECK_INTERVAL_MS = 5000;
const PROGRESS_LOG_INTERVAL_MS = 30000;
const MAX_CONSECUTIVE_PLANNING_LINES = 10;

function isRetryableError(stderr: string, exitCode: number): boolean {
  if (exitCode === 1 && !stderr) return false;
  return RETRYABLE_ERRORS.some((pattern) => pattern.test(stderr));
}

function isQuotaExceededError(message: string): boolean {
  return QUOTA_EXCEEDED_ERRORS.some((pattern) => pattern.test(message));
}

function extractQuotaRetryDelayMs(message: string): number | undefined {
  const retryInfoMatch = message.match(/retrydelay["']?\s*[:=]\s*["']?([0-9]+(?:\.[0-9]+)?)s["']?/i);
  if (retryInfoMatch?.[1]) {
    const seconds = Number.parseFloat(retryInfoMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.max(1000, Math.round(seconds * 1000));
    }
  }

  const retryInMatch = message.match(/retry in\s*([0-9]+(?:\.[0-9]+)?)s/i);
  if (retryInMatch?.[1]) {
    const seconds = Number.parseFloat(retryInMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.max(1000, Math.round(seconds * 1000));
    }
  }

  return undefined;
}

function normalizeChunkLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function hasRepeatedPattern(chunks: string[]): boolean {
  for (let patternLength = 1; patternLength <= DOOM_LOOP_PATTERN_MAX_LENGTH; patternLength++) {
    const requiredLength = patternLength * DOOM_LOOP_PATTERN_REPEAT_THRESHOLD;
    if (chunks.length < requiredLength) {
      continue;
    }
    const pattern = chunks.slice(-patternLength);
    let repeats = 1;
    while (chunks.length >= patternLength * (repeats + 1)) {
      const start = chunks.length - patternLength * (repeats + 1);
      const segment = chunks.slice(start, start + patternLength);
      const matched = segment.every((value, index) => value === pattern[index]);
      if (!matched) {
        break;
      }
      repeats++;
    }
    if (repeats >= DOOM_LOOP_PATTERN_REPEAT_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function calculateBackoffDelay(retryCount: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, 60000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildOpenCodePrompt(options: OpenCodeOptions): Promise<string> {
  if (!options.instructionsPath) {
    return options.task;
  }

  // 指示ファイルがある場合はタスクの先頭に結合する
  const instructions = await readFile(options.instructionsPath, "utf-8");
  const trimmed = instructions.trim();
  if (!trimmed) {
    return options.task;
  }

  return `${trimmed}\n\n${options.task}`;
}

async function executeOpenCodeOnce(
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
  const tempDir = await mkdtemp(join(tmpdir(), "sebastian-code-opencode-"));
  const promptPath = join(tempDir, "prompt.txt");

  // プロンプトをファイルで渡してCLIの引数制限やパース問題を避ける
  const prompt = await buildOpenCodePrompt(options);
  await writeFile(promptPath, prompt, "utf-8");

  const model = options.model ?? DEFAULT_MODEL;
  if (model) {
    args.push("--model", model);
  }

  // opencode 側の致命的エラーを stderr に出し、検知できるようにする
  args.push("--print-logs", "--log-level", "ERROR");
  args.push("--file", promptPath);
  args.push("--");
  args.push("添付したプロンプトを読んで指示に従ってください。");

  const baseEnv = options.inheritEnv === false ? {} : globalThis.process.env;
  const useProcessGroup = process.platform !== "win32";
  const childProcess = spawn("opencode", args, {
    cwd: options.workdir,
    env: {
      ...baseEnv,
      ...options.env,
    },
    // 子プロセスが残留しないようにプロセスグループで停止できる形にする
    detached: useProcessGroup,
    timeout: options.timeoutSeconds * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutSeconds * 1000;
  let timedOut = false;
  let idleTimedOut = false;
  let quotaExceeded = false;
  let printedErrorSummary = false;
  const MAX_ERROR_SUMMARY_LENGTH = 240;
  const terminateOpenCode = (signal: NodeJS.Signals): void => {
    const pid = childProcess.pid;
    if (!pid) {
      try {
        childProcess.kill(signal);
      } catch {
        // 既に終了している場合は無視する
      }
      return;
    }
    if (useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // プロセスグループ停止が失敗した場合はPIDを直接停止する
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // 既に終了している場合は無視する
    }
  };
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
    process.stderr.write("\n[OpenCode] ドゥームループを検出したため強制終了します。\n");
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

  childProcess.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    lastOutputAt = Date.now();
    lastVisibleProgressAt = Date.now();
    // リアルタイムでログに出力
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
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      if (!quotaExceeded && isQuotaExceededError(line)) {
        quotaExceeded = true;
        // クォータ超過は継続しても回復しないため早期に停止する
        process.stderr.write("\n[OpenCode] クォータ上限に到達したため中断します。\n");
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
      const quotaMessage = quotaExceeded ? "\n[OpenCode] クォータ上限に到達しました" : "";
      const doomLoopMessage = doomLoopDetected ? "\n[OpenCode] Doom loop detected" : "";

      return {
        success: !timedOut && !idleTimedOut && !quotaExceeded && !doomLoopDetected && code === 0,
        exitCode: timedOut || idleTimedOut || quotaExceeded || doomLoopDetected ? -1 : code ?? -1,
        stdout,
        stderr: stderr + timeoutMessage + idleTimeoutMessage + quotaMessage + doomLoopMessage,
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
      // closeイベント取りこぼし時の保険
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

    // ごく稀にclose/exitが飛ばない環境差を吸収する
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

export async function runOpenCode(
  options: OpenCodeOptions
): Promise<OpenCodeResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const waitOnQuota = DEFAULT_WAIT_ON_QUOTA;
  const quotaRetryDelayMs = Number.isFinite(DEFAULT_QUOTA_RETRY_DELAY_MS)
    && DEFAULT_QUOTA_RETRY_DELAY_MS > 0
    ? DEFAULT_QUOTA_RETRY_DELAY_MS
    : 30000;
  const maxQuotaWaits = Number.isFinite(DEFAULT_MAX_QUOTA_WAITS)
    ? DEFAULT_MAX_QUOTA_WAITS
    : -1;
  let currentModel = options.model ?? DEFAULT_MODEL;
  let fallbackUsed = false;
  let quotaWaitCount = 0;

  let lastResult: Omit<OpenCodeResult, "retryCount"> | null = null;
  let retryCount = 0;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const result = await executeOpenCodeOnce({ ...options, model: currentModel });
    lastResult = result;

    if (result.success) {
      return { ...result, retryCount };
    }

    if (isQuotaExceededError(result.stderr)) {
      if (waitOnQuota && (maxQuotaWaits < 0 || quotaWaitCount < maxQuotaWaits)) {
        quotaWaitCount++;
        const detectedDelay = extractQuotaRetryDelayMs(result.stderr);
        const waitMs = detectedDelay ?? quotaRetryDelayMs;
        console.warn(
          `[OpenCode] ${currentModel ?? "unknown model"} quota exceeded. ` +
          `Waiting ${Math.round(waitMs / 1000)}s before retry (${quotaWaitCount}${maxQuotaWaits < 0 ? "" : `/${maxQuotaWaits}`}).`
        );
        await delay(waitMs);
        continue;
      }
      console.error(
        `[OpenCode] ${currentModel ?? "unknown model"} のクォータ上限に到達しました。API利用枠を確認してください。`
      );
      break;
    }

    if (
      !fallbackUsed
      && currentModel !== DEFAULT_FALLBACK_MODEL
      && THOUGHT_SIGNATURE_ERROR.test(result.stderr)
    ) {
      // Gemini 3系のthought_signature必須エラー回避のためにモデルを切り替える
      fallbackUsed = true;
      currentModel = DEFAULT_FALLBACK_MODEL;
      console.warn(
        `[OpenCode] Fallback model applied: ${currentModel} (reason: thought_signature)`
      );
      continue;
    }

    if (attempt < maxRetries && isRetryableError(result.stderr, result.exitCode)) {
      attempt++;
      retryCount++;
      const backoffDelay = calculateBackoffDelay(attempt, retryDelayMs);
      console.log(`[OpenCode] Retry ${retryCount}/${maxRetries} after ${backoffDelay}ms`);
      await delay(backoffDelay);
    } else {
      break;
    }
  }

  return {
    ...(lastResult ?? {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: "No result",
      durationMs: 0,
    }),
    retryCount,
  };
}
