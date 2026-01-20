import { spawn } from "node:child_process";
import { z } from "zod";
import { extractTokenUsage, type TokenUsage } from "./parse.js";

// 推論の深さを制御するeffortレベル（Opus 4.5向け）
export const EffortLevel = z.enum(["low", "medium", "high"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

// デフォルト設定（環境変数で上書き可能）
const DEFAULT_MODEL = process.env.CLAUDE_MODEL;
const DEFAULT_EFFORT: EffortLevel = (process.env.CLAUDE_EFFORT as EffortLevel) ?? "medium";
const DEFAULT_MAX_RETRIES = parseInt(process.env.CLAUDE_MAX_RETRIES ?? "3", 10);
const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.CLAUDE_RETRY_DELAY_MS ?? "5000", 10);

// リトライ可能なエラーパターン
const RETRYABLE_ERRORS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /503/,
  /502/,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
];

// Claude Code実行オプション
export const ClaudeCodeOptions = z.object({
  // 作業ディレクトリ
  workdir: z.string(),
  // 指示ファイルパス
  instructionsPath: z.string().optional(),
  // タスク内容
  task: z.string(),
  // タイムアウト（秒）
  timeoutSeconds: z.number().int().positive().default(3600),
  // 許可するツール
  allowedTools: z.array(z.string()).optional(),
  // 環境変数
  env: z.record(z.string()).optional(),
  // 使用モデル（省略時はClaude Codeのデフォルト = Opus 4.5）
  model: z.string().optional(),
  // 推論の深さ（low: 高速・低コスト、medium: バランス、high: 最高精度）
  effort: EffortLevel.optional(),
  // リトライ設定
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
});
export type ClaudeCodeOptions = z.infer<typeof ClaudeCodeOptions>;

// 実行結果
export interface ClaudeCodeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  tokenUsage?: TokenUsage;
  retryCount: number;
}

// エラーがリトライ可能かどうかを判定
function isRetryableError(stderr: string, exitCode: number): boolean {
  // 明らかなプログラムエラーはリトライしない
  if (exitCode === 1 && !stderr) {
    return false;
  }

  // パターンマッチでリトライ可能なエラーを検出
  return RETRYABLE_ERRORS.some((pattern) => pattern.test(stderr));
}

// 指数バックオフでの遅延計算
function calculateBackoffDelay(retryCount: number, baseDelayMs: number): number {
  // 指数バックオフ + ジッター
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, 60000); // 最大60秒
}

// 遅延を待機
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 単一実行（リトライなし）
async function executeClaudeCodeOnce(
  options: ClaudeCodeOptions
): Promise<Omit<ClaudeCodeResult, "retryCount">> {
  const startTime = Date.now();

  // コマンド引数を構築
  const args: string[] = [];

  // モデル指定（環境変数またはオプションで指定）
  const model = options.model ?? DEFAULT_MODEL;
  if (model) {
    args.push("--model", model);
  }

  // effort パラメータ（Opus 4.5向け推論深さ制御）
  const effort = options.effort ?? DEFAULT_EFFORT;
  args.push("--effort", effort);

  if (options.instructionsPath) {
    args.push("--instructions", options.instructionsPath);
  }

  // タスクをpromptとして渡す
  args.push("--prompt", options.task);

  // Claude Codeプロセスを起動
  const childProcess = spawn("claude", args, {
    cwd: options.workdir,
    env: {
      ...globalThis.process.env,
      ...options.env,
    },
    timeout: options.timeoutSeconds * 1000,
  });

  // 出力を収集
  let stdout = "";
  let stderr = "";

  childProcess.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  childProcess.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // 完了を待機
  return new Promise((resolve) => {
    childProcess.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      const tokenUsage = extractTokenUsage(stdout);

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

// Claude Codeを実行（リトライ機能付き）
export async function runClaudeCode(
  options: ClaudeCodeOptions
): Promise<ClaudeCodeResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastResult: Omit<ClaudeCodeResult, "retryCount"> | null = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 実行
    const result = await executeClaudeCodeOnce(options);
    lastResult = result;

    // 成功した場合は即座に返す
    if (result.success) {
      return { ...result, retryCount };
    }

    // リトライ可能なエラーかチェック
    if (attempt < maxRetries && isRetryableError(result.stderr, result.exitCode)) {
      retryCount++;
      const backoffDelay = calculateBackoffDelay(attempt, retryDelayMs);
      console.log(
        `[Claude Code] Retry ${retryCount}/${maxRetries} after ${backoffDelay}ms ` +
        `(error: ${result.stderr.slice(0, 100)})`
      );
      await delay(backoffDelay);
    } else {
      // リトライ不可能なエラー、または最大リトライ回数に達した
      break;
    }
  }

  // 最後の結果を返す
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

// リトライなしで実行（テスト用や即時失敗が必要な場合）
export async function runClaudeCodeNoRetry(
  options: ClaudeCodeOptions
): Promise<ClaudeCodeResult> {
  const result = await executeClaudeCodeOnce(options);
  return { ...result, retryCount: 0 };
}
