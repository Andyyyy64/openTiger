import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";
import { calculateBackoffDelay, delay } from "../opencode/opencode-helpers";
import { parseIntegerEnvValue, readRuntimeEnv } from "../opencode/opencode-env";
import { CODEX_DEFAULT_MAX_RETRIES, CODEX_DEFAULT_RETRY_DELAY_MS } from "./codex-constants";
import { executeCodexOnce } from "./codex-executor";
import { isRetryableCodexError } from "./codex-helpers";

export async function runCodex(options: OpenCodeOptions): Promise<OpenCodeResult> {
  const envMaxRetries = parseIntegerEnvValue(
    readRuntimeEnv(options, "CODEX_MAX_RETRIES"),
    CODEX_DEFAULT_MAX_RETRIES,
  );
  const maxRetries = options.maxRetries ?? Math.max(0, envMaxRetries);
  const envRetryDelayMs = parseIntegerEnvValue(
    readRuntimeEnv(options, "CODEX_RETRY_DELAY_MS"),
    CODEX_DEFAULT_RETRY_DELAY_MS,
  );
  const retryDelayMs = options.retryDelayMs ?? Math.max(0, envRetryDelayMs);

  let lastResult: Omit<OpenCodeResult, "retryCount"> | null = null;
  let retryCount = 0;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const result = await executeCodexOnce(options);
    lastResult = result;
    if (result.success) {
      return { ...result, retryCount };
    }
    if (attempt < maxRetries && isRetryableCodexError(result.stderr, result.exitCode)) {
      attempt += 1;
      retryCount += 1;
      const backoffDelay = calculateBackoffDelay(attempt, retryDelayMs);
      console.log(`[Codex] Retry ${retryCount}/${maxRetries} after ${backoffDelay}ms`);
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
