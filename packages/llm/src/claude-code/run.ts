import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";
import { calculateBackoffDelay, delay } from "../opencode/opencode-helpers";
import { parseIntegerEnvValue, readRuntimeEnv } from "../opencode/opencode-env";
import {
  CLAUDE_CODE_DEFAULT_MAX_RETRIES,
  CLAUDE_CODE_DEFAULT_RETRY_DELAY_MS,
} from "./claude-code-constants";
import { isRetryableClaudeError } from "./claude-code-helpers";
import { executeClaudeCodeOnce } from "./claude-code-executor";

export async function runClaudeCode(options: OpenCodeOptions): Promise<OpenCodeResult> {
  const envMaxRetries = parseIntegerEnvValue(
    readRuntimeEnv(options, "CLAUDE_CODE_MAX_RETRIES"),
    CLAUDE_CODE_DEFAULT_MAX_RETRIES,
  );
  const maxRetries = options.maxRetries ?? Math.max(0, envMaxRetries);
  const envRetryDelayMs = parseIntegerEnvValue(
    readRuntimeEnv(options, "CLAUDE_CODE_RETRY_DELAY_MS"),
    CLAUDE_CODE_DEFAULT_RETRY_DELAY_MS,
  );
  const retryDelayMs = options.retryDelayMs ?? Math.max(0, envRetryDelayMs);

  let lastResult: Omit<OpenCodeResult, "retryCount"> | null = null;
  let retryCount = 0;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const result = await executeClaudeCodeOnce(options);
    lastResult = result;
    if (result.success) {
      return { ...result, retryCount };
    }
    if (attempt < maxRetries && isRetryableClaudeError(result.stderr, result.exitCode)) {
      attempt += 1;
      retryCount += 1;
      const backoffDelay = calculateBackoffDelay(attempt, retryDelayMs);
      console.log(`[ClaudeCode] Retry ${retryCount}/${maxRetries} after ${backoffDelay}ms`);
      await delay(backoffDelay);
      continue;
    }
    break;
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
