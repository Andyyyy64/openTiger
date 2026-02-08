import { Hono } from "hono";
import { db } from "@openTiger/db";
import { sql } from "drizzle-orm";

async function checkDatabaseReady(): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkRedisReady(): Promise<{ ok: boolean; error?: string }> {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  type RedisClient = {
    connect: () => Promise<unknown>;
    ping: () => Promise<string>;
    quit: () => Promise<unknown>;
    disconnect: () => void;
  };
  const { default: RedisCtor } = (await import("ioredis")) as unknown as {
    default: new (
      url: string,
      options: {
        lazyConnect: boolean;
        maxRetriesPerRequest: number;
        enableOfflineQueue: boolean;
      },
    ) => RedisClient;
  };
  const redisClient = new RedisCtor(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redisClient.connect();
    const pong = await redisClient.ping();
    await redisClient.quit();
    if (pong !== "PONG") {
      return { ok: false, error: `unexpected_ping_response:${pong}` };
    }
    return { ok: true };
  } catch (error) {
    if (redisClient) {
      redisClient.disconnect();
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    redisClient.disconnect();
  }
}

export const healthRoute = new Hono();

// ヘルスチェックエンドポイント
healthRoute.get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Detailed health check (DB connection verification, etc.)
healthRoute.get("/ready", async (c) => {
  const [database, redis] = await Promise.all([checkDatabaseReady(), checkRedisReady()]);
  const isReady = database.ok && redis.ok;

  return c.json(
    {
      status: isReady ? "ok" : "degraded",
      services: {
        database: database.ok ? "ok" : "error",
        redis: redis.ok ? "ok" : "error",
      },
      errors: {
        database: database.error,
        redis: redis.error,
      },
      timestamp: new Date().toISOString(),
    },
    isReady ? 200 : 503,
  );
});
