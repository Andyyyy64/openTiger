import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

// 認証方式
type AuthMethod = "bearer" | "api-key" | "none";

// 認証設定
interface AuthConfig {
  // 認証をスキップするパス（正規表現）
  skipPaths?: RegExp[];
  // 許可するAPIキー（カンマ区切りで複数可）
  apiKeys?: string[];
  // Bearerトークンの検証関数
  validateToken?: (token: string) => Promise<boolean> | boolean;
}

// デフォルト設定
const defaultConfig: AuthConfig = {
  skipPaths: [/^\/health/, /^\/api\/webhook\/github/],
  apiKeys: process.env.API_KEYS?.split(",").map((k) => k.trim()) ?? [],
};

// 認証ミドルウェア
export function authMiddleware(config: AuthConfig = defaultConfig) {
  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // スキップパスのチェック
    const shouldSkip = config.skipPaths?.some((pattern) => pattern.test(path));
    if (shouldSkip) {
      return next();
    }

    // 認証ヘッダーを取得
    const authHeader = c.req.header("Authorization");
    const apiKeyHeader = c.req.header("X-API-Key");

    // API Keyによる認証
    if (apiKeyHeader) {
      const isValidApiKey = config.apiKeys?.includes(apiKeyHeader);
      if (isValidApiKey) {
        // 認証情報をコンテキストに保存
        c.set("authMethod", "api-key" as AuthMethod);
        c.set("apiKey", apiKeyHeader);
        return next();
      }
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    // Bearerトークンによる認証
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // カスタム検証関数がある場合
      if (config.validateToken) {
        const isValid = await config.validateToken(token);
        if (isValid) {
          c.set("authMethod", "bearer" as AuthMethod);
          c.set("token", token);
          return next();
        }
        throw new HTTPException(401, { message: "Invalid token" });
      }

      // デフォルト: API_SECRETと比較
      const apiSecret = process.env.API_SECRET;
      if (apiSecret && token === apiSecret) {
        c.set("authMethod", "bearer" as AuthMethod);
        return next();
      }
      throw new HTTPException(401, { message: "Invalid token" });
    }

    // 認証ヘッダーがない場合
    // 開発環境では認証をスキップ（API_SECRET未設定時）
    if (!process.env.API_SECRET && !config.apiKeys?.length) {
      c.set("authMethod", "none" as AuthMethod);
      return next();
    }

    throw new HTTPException(401, {
      message: "Authentication required",
    });
  });
}

// 管理者権限チェックミドルウェア
export function adminOnly() {
  return createMiddleware(async (c: Context, next: Next) => {
    const authMethod = c.get("authMethod") as AuthMethod | undefined;

    // API Keyまたは有効なトークンが必要
    if (authMethod === "api-key" || authMethod === "bearer") {
      return next();
    }

    throw new HTTPException(403, {
      message: "Admin access required",
    });
  });
}

// 認証情報を取得するヘルパー
export function getAuthInfo(c: Context): {
  method: AuthMethod;
  apiKey?: string;
  token?: string;
} {
  return {
    method: (c.get("authMethod") as AuthMethod) ?? "none",
    apiKey: c.get("apiKey") as string | undefined,
    token: c.get("token") as string | undefined,
  };
}
