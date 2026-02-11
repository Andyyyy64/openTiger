import type { Logger } from "./logger";

// Retry configuration
export interface RetryConfig {
  // Maximum retry count
  maxAttempts: number;
  // Delay before first retry (ms)
  initialDelayMs: number;
  // Maximum delay (ms)
  maxDelayMs: number;
  // Backoff multiplier
  backoffMultiplier: number;
  // Predicate to determine if error is retryable
  isRetryable?: (error: Error) => boolean;
}

// Retry result
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDurationMs: number;
}

// Default retry configuration
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 5000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
};

// Retryable error patterns
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

// Retryable patterns for test failures
const TEST_FAILURE_RETRYABLE_PATTERNS = [
  /test.*(fail|error)/i,
  /lint.*(fail|error)/i,
  /typecheck.*(fail|error)/i,
  /compile.*(fail|error)/i,
];

// Default retryability check
export function isRetryableError(error: Error): boolean {
  const message = error.message;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

// Test failures are retryable (for self-healing)
export function isTestFailureRetryable(error: Error): boolean {
  const message = error.message;
  return TEST_FAILURE_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

// Compute delay with exponential backoff
function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, config.maxDelayMs);
}

// Wait
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Execute function with retries
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

      // Check if retryable
      const isRetryable = opts.isRetryable
        ? opts.isRetryable(lastError)
        : isRetryableError(lastError);

      if (!isRetryable || attempt >= opts.maxAttempts) {
        // Not retryable or max attempts reached
        logger?.error(`Failed after ${attempt} attempts: ${lastError.message}`);
        break;
      }

      // Wait before retry
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

// Self-healing retry on test failure
// Tell OpenCode about previous failure and request a fix
export interface SelfHealingConfig extends RetryConfig {
  // Function to build prompt including failure info
  createRetryPrompt: (originalTask: string, error: string, attempt: number) => string;
}

// Self-healing prompt template
export function createSelfHealingPrompt(
  originalTask: string,
  error: string,
  attempt: number,
): string {
  return `
## Previous Execution Failed (Attempt ${attempt})

### Error
\`\`\`
${error}
\`\`\`

### Fix Request
Resolve the error above. The original task is:

---

${originalTask}

---

### Notes
- Implement carefully based on the previous failure
- Identify the root cause before applying a fix
- Avoid repeating the same error
`;
}

// Default self-healing configuration
export const DEFAULT_SELF_HEALING_CONFIG: SelfHealingConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxAttempts: 3,
  initialDelayMs: 10000,
  isRetryable: (error) => isRetryableError(error) || isTestFailureRetryable(error),
  createRetryPrompt: createSelfHealingPrompt,
};
