import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

// Authentication method
type AuthMethod = "bearer" | "api-key" | "none";

// Authentication configuration
interface AuthConfig {
  // Paths to skip authentication (regex)
  skipPaths?: RegExp[];
  // Allowed API keys (comma-separated, multiple allowed)
  apiKeys?: string[];
  // Bearer token validation function
  validateToken?: (token: string) => Promise<boolean> | boolean;
}

// Default configuration
const defaultConfig: AuthConfig = {
  skipPaths: [/^\/health/, /^\/(?:api\/)?webhook\/github/],
  apiKeys:
    process.env.API_KEYS
      ?.split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0) ?? [],
};

// Authentication middleware
export function authMiddleware(config: AuthConfig = defaultConfig) {
  return createMiddleware(async (c: Context, next: Next) => {
    const path = c.req.path;

    // Check skip paths
    const shouldSkip = config.skipPaths?.some((pattern) => pattern.test(path));
    if (shouldSkip) {
      return next();
    }

    // Get authentication headers
    const authHeader = c.req.header("Authorization");
    const apiKeyHeader = c.req.header("X-API-Key");

    // Authenticate with API Key
    if (apiKeyHeader) {
      const isValidApiKey = config.apiKeys?.includes(apiKeyHeader);
      if (isValidApiKey) {
        // Save authentication info to context
        c.set("authMethod", "api-key" as AuthMethod);
        c.set("apiKey", apiKeyHeader);
        return next();
      }
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    // Authenticate with Bearer token
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // If custom validation function exists
      if (config.validateToken) {
        const isValid = await config.validateToken(token);
        if (isValid) {
          c.set("authMethod", "bearer" as AuthMethod);
          c.set("token", token);
          return next();
        }
        throw new HTTPException(401, { message: "Invalid token" });
      }

      // Default: compare with API_SECRET
      const apiSecret = process.env.API_SECRET;
      if (apiSecret && token === apiSecret) {
        c.set("authMethod", "bearer" as AuthMethod);
        return next();
      }
      throw new HTTPException(401, { message: "Invalid token" });
    }

    // If no authentication header
    // Skip authentication in development (when API_SECRET is not set)
    if (!process.env.API_SECRET && !config.apiKeys?.length) {
      c.set("authMethod", "none" as AuthMethod);
      return next();
    }

    throw new HTTPException(401, {
      message: "Authentication required",
    });
  });
}

// Admin-only access check middleware
export function adminOnly() {
  return createMiddleware(async (c: Context, next: Next) => {
    const authMethod = c.get("authMethod") as AuthMethod | undefined;

    // API Key or valid token required
    if (authMethod === "api-key" || authMethod === "bearer") {
      return next();
    }

    throw new HTTPException(403, {
      message: "Admin access required",
    });
  });
}

// Helper to get authentication info
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
