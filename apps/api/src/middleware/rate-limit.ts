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

// In-memory store (Redis recommended for production)
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Periodically clean up old entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60000); // 1分ごと

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

  // Direct connection (fallback as Hono doesn't get it by default)
  return "unknown";
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
    const now = Date.now();

    // Get current entry
    let entry = store.get(key);

    // Create new entry if none exists or expired
    if (!entry || entry.resetAt < now) {
      entry = {
        count: 0,
        resetAt: now + cfg.windowMs,
      };
    }

    // Increment count
    entry.count++;
    store.set(key, entry);

    // Set response headers
    const remaining = Math.max(0, cfg.maxRequests - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header("X-RateLimit-Limit", String(cfg.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    // Check limit exceeded
    if (entry.count > cfg.maxRequests) {
      c.header("Retry-After", String(resetSeconds));
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
        const now = Date.now();

        let entry = store.get(key);
        if (!entry || entry.resetAt < now) {
          entry = { count: 0, resetAt: now + limit.windowMs };
        }

        entry.count++;
        store.set(key, entry);

        if (entry.count > limit.maxRequests) {
          const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
          c.header("Retry-After", String(resetSeconds));
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
