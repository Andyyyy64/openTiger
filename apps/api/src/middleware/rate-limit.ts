import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

// Rate limit configuration
interface RateLimitConfig {
  // ウィンドウ時間（ミリ秒）
  windowMs: number;
  // ウィンドウ内の最大リクエスト数
  maxRequests: number;
  // レート制限をスキップするパス
  skipPaths?: RegExp[];
  // クライアント識別子の取得方法
  keyGenerator?: (c: Context) => string;
  // 制限超過時のメッセージ
  message?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, RateLimitEntry>();
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.resetAt < now) {
      memoryStore.delete(key);
    }
  }
}, 60000);
cleanupTimer.unref();

const redisUrl = process.env.REDIS_URL?.trim();
type RedisClient = import("ioredis").Redis;
let redisClient: RedisClient | null = null;
let redisErrorLogged = false;
let redisRetryAfterMs = 0;
const redisReconnectDelayMs = Number.parseInt(
  process.env.API_RATE_LIMIT_REDIS_RECONNECT_DELAY_MS ?? "30000",
  10
);

async function getRedisClient(): Promise<RedisClient | null> {
  if (!redisUrl) {
    return null;
  }
  if (Date.now() < redisRetryAfterMs) {
    return null;
  }
  if (redisClient) {
    return redisClient;
  }
  const { Redis } = await import("ioredis");
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redisClient.on("error", (error: Error) => {
    if (!redisErrorLogged) {
      console.warn("[RateLimit] Redis unavailable, falling back to in-memory store:", error.message);
      redisErrorLogged = true;
    }
  });
  return redisClient;
}

async function incrementMemoryRateLimit(
  key: string,
  windowMs: number
): Promise<RateLimitEntry> {
  const now = Date.now();
  let entry = memoryStore.get(key);
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + windowMs,
    };
  }

  entry.count++;
  memoryStore.set(key, entry);
  return entry;
}

async function incrementRateLimit(
  key: string,
  windowMs: number
): Promise<RateLimitEntry> {
  const redis = await getRedisClient();
  if (!redis) {
    return incrementMemoryRateLimit(key, windowMs);
  }

  const redisKey = `openTiger:rate-limit:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pexpire(redisKey, windowMs);
    }
    const ttlMs = await redis.pttl(redisKey);
    const now = Date.now();
    redisRetryAfterMs = 0;
    redisErrorLogged = false;
    return {
      count,
      resetAt: now + Math.max(ttlMs, 0),
    };
  } catch (error) {
    if (!redisErrorLogged) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[RateLimit] Redis operation failed, falling back to in-memory store:", message);
      redisErrorLogged = true;
    }
    redisRetryAfterMs = Date.now() + (
      Number.isFinite(redisReconnectDelayMs) && redisReconnectDelayMs > 0
        ? redisReconnectDelayMs
        : 30000
    );
    if (redisClient) {
      redisClient.disconnect();
      redisClient = null;
    }
    return incrementMemoryRateLimit(key, windowMs);
  }
}

// Default configuration
const defaultConfig: RateLimitConfig = {
  windowMs: 60 * 1000, // 1分
  maxRequests: 100, // 1分あたり100リクエスト
  skipPaths: [/^\/health/],
  message: "Too many requests, please try again later",
};

// Get client IP
function getClientIP(c: Context): string {
  // If via proxy
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0];
    if (firstIp) {
      return firstIp.trim();
    }
  }

  const realIp = c.req.header("X-Real-IP");
  if (realIp) {
    return realIp;
  }

  const cfConnectingIp = c.req.header("CF-Connecting-IP");
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Direct connection fallback (avoid collapsing all callers to a single unknown key)
  const userAgent = c.req.header("User-Agent")?.trim() || "na";
  return `unknown:${userAgent.slice(0, 80)}`;
}

// Rate limit middleware
export function rateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const cfg = { ...defaultConfig, ...config };

  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // Check skip paths
    const shouldSkip = cfg.skipPaths?.some((pattern) => pattern.test(path));
    if (shouldSkip) {
      return next();
    }

    // Get client identifier
    const key = cfg.keyGenerator?.(c) ?? getClientIP(c);
    const entry = await incrementRateLimit(key, cfg.windowMs);
    const now = Date.now();

    // Set response headers
    const remaining = Math.max(0, cfg.maxRequests - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header("X-RateLimit-Limit", String(cfg.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.max(resetSeconds, 0)));

    // Check limit exceeded
    if (entry.count > cfg.maxRequests) {
      c.header("Retry-After", String(Math.max(resetSeconds, 0)));
      throw new HTTPException(429, {
        message: cfg.message,
      });
    }

    return next();
  });
}

// Rate limiting per endpoint
export function endpointRateLimit(
  limits: Record<string, { windowMs: number; maxRequests: number }>
) {
  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // Find limit corresponding to path
    for (const [pattern, limit] of Object.entries(limits)) {
      if (path.startsWith(pattern) || new RegExp(pattern).test(path)) {
        const key = `${getClientIP(c)}:${pattern}`;
        const entry = await incrementRateLimit(key, limit.windowMs);

        if (entry.count > limit.maxRequests) {
          const resetSeconds = Math.ceil((entry.resetAt - Date.now()) / 1000);
          c.header("Retry-After", String(Math.max(resetSeconds, 0)));
          throw new HTTPException(429, {
            message: `Rate limit exceeded for ${pattern}`,
          });
        }

        break;
      }
    }

    return next();
  });
}
