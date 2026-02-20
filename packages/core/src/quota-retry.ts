type DurationUnit = "ms" | "s" | "m";

function parseDurationTokenMs(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) {
    return null;
  }
  const rawAmount = match[1];
  if (!rawAmount) {
    return null;
  }
  const amount = Number.parseFloat(rawAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const unit = (match[2]?.toLowerCase() ?? "s") as DurationUnit;
  if (unit === "ms") {
    return Math.ceil(amount);
  }
  if (unit === "m") {
    return Math.ceil(amount * 60_000);
  }
  return Math.ceil(amount * 1_000);
}

function parseClockRetryDelayMs(
  errorMessage: string,
  referenceDate: Date | undefined,
): number | null {
  const match = errorMessage.match(
    /\b(?:try again|retry|resets?|available)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  );
  const hourToken = match?.[1];
  const minuteToken = match?.[2];
  const meridiemToken = match?.[3];
  if (!hourToken || !meridiemToken) {
    return null;
  }

  const hour12 = Number.parseInt(hourToken, 10);
  const minute = minuteToken ? Number.parseInt(minuteToken, 10) : 0;
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) {
    return null;
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    return null;
  }

  let hour24 = hour12 % 12;
  if (meridiemToken.toLowerCase() === "pm") {
    hour24 += 12;
  }

  const now = referenceDate ? new Date(referenceDate) : new Date();
  const nextRetryAt = new Date(now);
  nextRetryAt.setSeconds(0, 0);
  nextRetryAt.setHours(hour24, minute, 0, 0);
  if (nextRetryAt.getTime() <= now.getTime()) {
    nextRetryAt.setDate(nextRetryAt.getDate() + 1);
  }
  const delayMs = nextRetryAt.getTime() - now.getTime();
  return delayMs > 0 ? delayMs : null;
}

export function parseQuotaRetryDelayMs(
  errorMessage: string | null | undefined,
  referenceDate?: Date,
): number | null {
  if (!errorMessage) {
    return null;
  }
  const patterns = [
    /please retry in\s+(\d+(?:\.\d+)?)s/i,
    /retry in\s+(\d+(?:\.\d+)?)s/i,
    /"retryDelay"\s*:\s*"([^"]+)"/i,
    /retrydelay["\s:=]+(\d+(?:\.\d+)?s?)/i,
  ];

  const candidates: number[] = [];
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    const raw = match?.[1];
    if (!raw) {
      continue;
    }
    const ms = parseDurationTokenMs(raw);
    if (ms && ms > 0) {
      candidates.push(ms);
    }
  }

  const clockDelayMs = parseClockRetryDelayMs(errorMessage, referenceDate);
  if (clockDelayMs && clockDelayMs > 0) {
    candidates.push(clockDelayMs);
  }

  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

function deterministicJitter(taskId: string, retryCount: number, maxJitterMs: number): number {
  if (maxJitterMs <= 0) {
    return 0;
  }
  let hash = 0;
  const seed = `${taskId}:${retryCount}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % (maxJitterMs + 1);
}

export interface QuotaBackoffOptions {
  taskId: string;
  retryCount: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterRatio: number;
  errorMessage?: string | null;
  referenceDate?: Date;
}

export interface QuotaBackoffResult {
  cooldownMs: number;
  retryHintMs: number | null;
  exponentialMs: number;
  jitterMs: number;
}

export function computeQuotaBackoff(options: QuotaBackoffOptions): QuotaBackoffResult {
  const baseDelayMs = Math.max(1_000, Math.floor(options.baseDelayMs));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs));
  const retryCount = Math.max(0, Math.floor(options.retryCount));
  const factor = Number.isFinite(options.factor) && options.factor > 1 ? options.factor : 2;
  const jitterRatio =
    Number.isFinite(options.jitterRatio) && options.jitterRatio >= 0
      ? Math.min(options.jitterRatio, 1)
      : 0.2;

  const retryHintMs = parseQuotaRetryDelayMs(options.errorMessage ?? null, options.referenceDate);
  const exponentialMs = Math.min(maxDelayMs, Math.ceil(baseDelayMs * Math.pow(factor, retryCount)));
  // 提供元が明示した再開時刻はジッターを加えず優先する。
  if (retryHintMs !== null && retryHintMs > 0) {
    const cooldownMs = Math.max(exponentialMs, retryHintMs);
    return {
      cooldownMs,
      retryHintMs,
      exponentialMs,
      jitterMs: 0,
    };
  }

  const preJitterMs = Math.min(maxDelayMs, Math.max(exponentialMs, retryHintMs ?? 0));
  const maxJitterMs = Math.floor(preJitterMs * jitterRatio);
  const jitterMs = deterministicJitter(options.taskId, retryCount, maxJitterMs);
  const cooldownMs = Math.min(maxDelayMs, preJitterMs + jitterMs);

  return {
    cooldownMs,
    retryHintMs,
    exponentialMs,
    jitterMs,
  };
}
