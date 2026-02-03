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

const RETRYABLE_ERRORS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /503/,
  /502/,
  /overloaded/i,
  /ETIMEDOUT/,
];

const THOUGHT_SIGNATURE_ERROR = /thought[_\s-]?signature/i;

function isRetryableError(stderr: string, exitCode: number): boolean {
  if (exitCode === 1 && !stderr) return false;
  return RETRYABLE_ERRORS.some((pattern) => pattern.test(stderr));
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

  args.push("--file", promptPath);
  args.push("--");
  args.push("添付したプロンプトを読んで指示に従ってください。");

  const childProcess = spawn("opencode", args, {
    cwd: options.workdir,
    env: {
      ...globalThis.process.env,
      ...options.env,
    },
    timeout: options.timeoutSeconds * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  childProcess.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    // リアルタイムでログに出力
    process.stdout.write(chunk);
  });

  childProcess.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    // リアルタイムでログに出力
    process.stderr.write(chunk);
  });

  return new Promise((resolve) => {
    childProcess.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      const tokenUsage = extractOpenCodeTokenUsage(stdout);

      rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs,
        tokenUsage,
      });
    });

    childProcess.on("error", (error) => {
      const durationMs = Date.now() - startTime;
      rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + error.message,
        durationMs,
      });
    });
  });
}

export async function runOpenCode(
  options: OpenCodeOptions
): Promise<OpenCodeResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let currentModel = options.model ?? DEFAULT_MODEL;
  let fallbackUsed = false;

  let lastResult: Omit<OpenCodeResult, "retryCount"> | null = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await executeOpenCodeOnce({ ...options, model: currentModel });
    lastResult = result;

    if (result.success) {
      return { ...result, retryCount };
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
