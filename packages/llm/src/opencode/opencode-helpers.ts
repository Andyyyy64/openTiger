import {
  ANSI_ESCAPE_REGEX,
  CONTROL_CHARS_REGEX,
  DOOM_LOOP_PATTERN_MAX_LENGTH,
  DOOM_LOOP_PATTERN_REPEAT_THRESHOLD,
  QUOTA_EXCEEDED_ERRORS,
  RETRYABLE_ERRORS,
} from "./opencode-constants";

export function isRetryableError(stderr: string, exitCode: number): boolean {
  if (exitCode === 1 && !stderr) return false;
  return RETRYABLE_ERRORS.some((pattern) => pattern.test(stderr));
}

export function isQuotaExceededError(message: string): boolean {
  return QUOTA_EXCEEDED_ERRORS.some((pattern) => pattern.test(message));
}

export function isResourceExhaustedError(message: string): boolean {
  return /resource has been exhausted|resource_exhausted/i.test(message);
}

export function isTitleGenerationLine(message: string): boolean {
  return (
    /agent=title|failed to generate title|service=session\.prompt/i.test(message) ||
    // OpenCodeの再試行エラーにはtitle生成用のsystem promptが埋め込まれることがある
    /you are a title generator|generate a brief title|the following is the text to summarize/i.test(
      message,
    )
  );
}

export function isTitleOnlyQuotaError(message: string): boolean {
  const lines = message.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const quotaLines = lines.filter((line) => isQuotaExceededError(line));
  if (quotaLines.length === 0) {
    return false;
  }
  return quotaLines.every((line) => isTitleGenerationLine(line));
}

export function extractQuotaRetryDelayMs(message: string): number | undefined {
  const retryInfoMatch = message.match(
    /retrydelay["']?\s*[:=]\s*["']?([0-9]+(?:\.[0-9]+)?)s["']?/i,
  );
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

export function normalizeChunkLine(line: string): string {
  return line.replace(ANSI_ESCAPE_REGEX, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function normalizeForPromptDetection(text: string): string {
  return text
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function hasRepeatedPattern(chunks: string[]): boolean {
  if (DOOM_LOOP_PATTERN_MAX_LENGTH <= 0 || DOOM_LOOP_PATTERN_REPEAT_THRESHOLD <= 1) {
    return false;
  }
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

export function calculateBackoffDelay(retryCount: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, 60000);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
