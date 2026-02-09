import type { OpenCodeOptions, OpenCodeResult } from "./opencode-types";
import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MAX_QUOTA_WAITS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL,
  DEFAULT_QUOTA_RETRY_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_WAIT_ON_QUOTA,
  THOUGHT_SIGNATURE_ERROR,
} from "./opencode-constants";
import {
  extractQuotaRetryDelayMs,
  isQuotaExceededError,
  isResourceExhaustedError,
  isTitleOnlyQuotaError,
  isRetryableError,
  calculateBackoffDelay,
  delay,
} from "./opencode-helpers";
import { parseBooleanEnvValue, parseIntegerEnvValue, readRuntimeEnv } from "./opencode-env";
import { executeOpenCodeOnce } from "./opencode-executor";

export { OpenCodeOptions } from "./opencode-types";
export type { OpenCodeResult } from "./opencode-types";

function buildApiKeyFingerprint(options: OpenCodeOptions): string {
  const fromOptions = options.env?.GEMINI_API_KEY?.trim();
  const fromProcess = process.env.GEMINI_API_KEY?.trim();
  const value = fromOptions || fromProcess;
  if (!value) {
    return "gemini:unset";
  }
  const tailLength = 5;
  const tail = value.slice(-tailLength);
  const maskedBodyLength = Math.max(0, value.length - tail.length);
  const maskedBody = "*".repeat(Math.min(maskedBodyLength, 8));
  const source = fromOptions ? "task_env" : "process_env";
  return `gemini:${maskedBody}${tail}(${source})`;
}

export async function runOpenCode(options: OpenCodeOptions): Promise<OpenCodeResult> {
  const apiKeyFingerprint = buildApiKeyFingerprint(options);
  console.log(`[OpenCode] API key fingerprint: ${apiKeyFingerprint}`);

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const waitOnQuota = parseBooleanEnvValue(
    readRuntimeEnv(options, "OPENCODE_WAIT_ON_QUOTA"),
    DEFAULT_WAIT_ON_QUOTA,
  );
  const runtimeQuotaRetryDelayMs = parseIntegerEnvValue(
    readRuntimeEnv(options, "OPENCODE_QUOTA_RETRY_DELAY_MS"),
    DEFAULT_QUOTA_RETRY_DELAY_MS,
  );
  const quotaRetryDelayMs =
    Number.isFinite(runtimeQuotaRetryDelayMs) && runtimeQuotaRetryDelayMs > 0
      ? runtimeQuotaRetryDelayMs
      : 30000;
  const runtimeMaxQuotaWaits = parseIntegerEnvValue(
    readRuntimeEnv(options, "OPENCODE_MAX_QUOTA_WAITS"),
    DEFAULT_MAX_QUOTA_WAITS,
  );
  const maxQuotaWaits = Number.isFinite(runtimeMaxQuotaWaits) ? runtimeMaxQuotaWaits : -1;
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
      if (isTitleOnlyQuotaError(result.stderr)) {
        if (attempt < maxRetries) {
          attempt++;
          retryCount++;
          const backoffDelay = calculateBackoffDelay(attempt, retryDelayMs);
          console.warn(
            `[OpenCode] Title-generation quota error detected. Retrying (${retryCount}/${maxRetries}) after ${backoffDelay}ms.`,
          );
          await delay(backoffDelay);
          continue;
        }
        console.warn(
          "[OpenCode] Title-generation quota error persisted; continuing error handling without quota handoff.",
        );
      } else {
        // resource_exhausted の場合は文言を切り替える
        const resourceExhausted = isResourceExhaustedError(result.stderr);
        const quotaLabel = resourceExhausted ? "Resource has been exhausted" : "Quota exceeded";
        const quotaHint = resourceExhausted
          ? "Please retry later or check provider capacity."
          : "Please check your API quota.";
        if (waitOnQuota && (maxQuotaWaits < 0 || quotaWaitCount < maxQuotaWaits)) {
          quotaWaitCount++;
          const detectedDelay = extractQuotaRetryDelayMs(result.stderr);
          const waitMs = detectedDelay ?? quotaRetryDelayMs;
          console.warn(
            `[OpenCode] ${currentModel ?? "unknown model"} ${quotaLabel}. ` +
              `Waiting ${Math.round(waitMs / 1000)}s before retry (${quotaWaitCount}${maxQuotaWaits < 0 ? "" : `/${maxQuotaWaits}`}).`,
          );
          await delay(waitMs);
          continue;
        }
        console.error(
          `[OpenCode] ${currentModel ?? "unknown model"} ${quotaLabel}. ${quotaHint}`,
        );
        break;
      }
    }

    if (
      !fallbackUsed &&
      currentModel !== DEFAULT_FALLBACK_MODEL &&
      THOUGHT_SIGNATURE_ERROR.test(result.stderr)
    ) {
      // Switch model to avoid Gemini 3 thought_signature required error
      fallbackUsed = true;
      currentModel = DEFAULT_FALLBACK_MODEL;
      console.warn(
        `[OpenCode] Fallback model applied: ${currentModel} (reason: thought_signature)`,
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
