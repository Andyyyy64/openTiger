import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

// レート制限設定
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

// インメモリストア（本番環境ではRedisを使用推奨）
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// 古いエントリを定期的にクリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60000); // 1分ごと

// デフォルト設定
const defaultConfig: RateLimitConfig = {
  windowMs: 60 * 1000, // 1分
  maxRequests: 100, // 1分あたり100リクエスト
  skipPaths: [/^\/health/],
  message: "Too many requests, please try again later",
};

// クライアントIPを取得
function getClientIP(c: Context): string {
  // プロキシ経由の場合
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

  // 直接接続の場合（Honoではデフォルトで取得不可のためフォールバック）
  return "unknown";
}

// レート制限ミドルウェア
export function rateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const cfg = { ...defaultConfig, ...config };

  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // スキップパスのチェック
    const shouldSkip = cfg.skipPaths?.some((pattern) => pattern.test(path));
    if (shouldSkip) {
      return next();
    }

    // クライアント識別子を取得
    const key = cfg.keyGenerator?.(c) ?? getClientIP(c);
    const now = Date.now();

    // 現在のエントリを取得
    let entry = store.get(key);

    // エントリがないか期限切れの場合は新規作成
    if (!entry || entry.resetAt < now) {
      entry = {
        count: 0,
        resetAt: now + cfg.windowMs,
      };
    }

    // カウントを増加
    entry.count++;
    store.set(key, entry);

    // レスポンスヘッダーを設定
    const remaining = Math.max(0, cfg.maxRequests - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header("X-RateLimit-Limit", String(cfg.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    // 制限超過チェック
    if (entry.count > cfg.maxRequests) {
      c.header("Retry-After", String(resetSeconds));
      throw new HTTPException(429, {
        message: cfg.message,
      });
    }

    return next();
  });
}

// エンドポイント別のレート制限
export function endpointRateLimit(
  limits: Record<string, { windowMs: number; maxRequests: number }>
) {
  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // パスに対応する制限を検索
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
