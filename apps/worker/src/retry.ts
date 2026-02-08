import type { Logger } from "./logger";

// リトライ設定
export interface RetryConfig {
  // 最大リトライ回数
  maxAttempts: number;
  // 初回リトライまでの待機時間（ミリ秒）
  initialDelayMs: number;
  // 最大待機時間（ミリ秒）
  maxDelayMs: number;
  // バックオフ係数
  backoffMultiplier: number;
  // リトライ可能なエラーかを判定する関数
  isRetryable?: (error: Error) => boolean;
}

// リトライ結果
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDurationMs: number;
}

// デフォルトのリトライ設定
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 5000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
};

// リトライ可能なエラーパターン
const RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /timeout/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /temporarily.?unavailable/i,
  /service.?unavailable/i,
  /internal.?server.?error/i,
  /503/,
  /502/,
  /429/,
];

// テスト失敗時のリトライ可能パターン
const TEST_FAILURE_RETRYABLE_PATTERNS = [
  /test.*(fail|error)/i,
  /lint.*(fail|error)/i,
  /typecheck.*(fail|error)/i,
  /compile.*(fail|error)/i,
];

// デフォルトのリトライ可能判定
export function isRetryableError(error: Error): boolean {
  const message = error.message;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

// テスト失敗はリトライ可能（自己修正のため）
export function isTestFailureRetryable(error: Error): boolean {
  const message = error.message;
  return TEST_FAILURE_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

// 指数バックオフで待機時間を計算
function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  // ジッターを追加（±10%）
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, config.maxDelayMs);
}

// 待機
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// リトライ付きで関数を実行
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  logger?: Logger,
): Promise<RetryResult<T>> {
  const opts: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts: attempt,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // リトライ可能かチェック
      const isRetryable = opts.isRetryable
        ? opts.isRetryable(lastError)
        : isRetryableError(lastError);

      if (!isRetryable || attempt >= opts.maxAttempts) {
        // リトライ不可能または最大試行回数に達した
        logger?.error(`Failed after ${attempt} attempts: ${lastError.message}`);
        break;
      }

      // リトライ待機
      const delay = calculateDelay(attempt, opts);
      logger?.retry(attempt, opts.maxAttempts, lastError.message);
      logger?.info(`Waiting ${Math.round(delay)}ms before retry...`);
      await sleep(delay);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: opts.maxAttempts,
    totalDurationMs: Date.now() - startTime,
  };
}

// テスト失敗時の自己修正リトライ
// OpenCodeに前回の失敗を伝えて修正を依頼
export interface SelfHealingConfig extends RetryConfig {
  // 失敗情報を含めたプロンプトを生成する関数
  createRetryPrompt: (originalTask: string, error: string, attempt: number) => string;
}

// 自己修正用のプロンプトテンプレート
export function createSelfHealingPrompt(
  originalTask: string,
  error: string,
  attempt: number,
): string {
  return `
## 前回の実行で失敗しました（試行 ${attempt}回目）

### エラー内容
\`\`\`
${error}
\`\`\`

### 修正依頼
上記のエラーを解消してください。元のタスクは以下の通りです：

---

${originalTask}

---

### 注意事項
- 前回の失敗を踏まえて、より慎重に実装してください
- エラーの根本原因を理解してから修正してください
- 同じエラーを繰り返さないようにしてください
`;
}

// デフォルトの自己修正設定
export const DEFAULT_SELF_HEALING_CONFIG: SelfHealingConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxAttempts: 3,
  initialDelayMs: 10000,
  isRetryable: (error) => isRetryableError(error) || isTestFailureRetryable(error),
  createRetryPrompt: createSelfHealingPrompt,
};
