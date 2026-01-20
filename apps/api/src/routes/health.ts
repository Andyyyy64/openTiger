import { Hono } from "hono";

export const healthRoute = new Hono();

// ヘルスチェックエンドポイント
healthRoute.get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// 詳細ヘルスチェック（DB接続確認など）
healthRoute.get("/ready", async (c) => {
  // TODO: DB接続確認を追加
  return c.json({
    status: "ok",
    services: {
      database: "ok",
      redis: "ok",
    },
    timestamp: new Date().toISOString(),
  });
});
