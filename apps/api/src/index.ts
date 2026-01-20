import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { tasksRoute } from "./routes/tasks.js";
import { runsRoute } from "./routes/runs.js";
import { agentsRoute } from "./routes/agents.js";
import { healthRoute } from "./routes/health.js";

const app = new Hono();

// ミドルウェア
app.use("*", logger());
app.use("*", cors());

// ルート
app.route("/health", healthRoute);
app.route("/api/tasks", tasksRoute);
app.route("/api/runs", runsRoute);
app.route("/api/agents", agentsRoute);

// ルートパス
app.get("/", (c) => {
  return c.json({
    name: "h1ve",
    version: "0.1.0",
    description: "AI Agent Orchestration System",
  });
});

// サーバー起動
const port = parseInt(process.env.API_PORT ?? "3000", 10);

console.log(`h1ve API server starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
