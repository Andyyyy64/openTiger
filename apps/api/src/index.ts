import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import "dotenv/config";
import { tasksRoute } from "./routes/tasks.js";
import { runsRoute } from "./routes/runs.js";
import { agentsRoute } from "./routes/agents.js";
import { healthRoute } from "./routes/health.js";
import { webhookRoute } from "./routes/webhook.js";
import { plansRoute } from "./routes/plans.js";
import { judgementsRoute } from "./routes/judgements.js";
import { logsRoute } from "./routes/logs.js";
import { configRoute } from "./routes/config.js";
import { systemRoute } from "./routes/system.js";
import { authMiddleware, rateLimitMiddleware } from "./middleware/index.js";

setupProcessLogging(process.env.OPENTIGER_LOG_NAME ?? "api", { label: "API" });

const app = new Hono();

// ミドルウェア
app.use("*", logger());
app.use("*", cors());
app.use("*", rateLimitMiddleware());
app.use("*", authMiddleware());

// ルート
app.route("/health", healthRoute);
app.route("/tasks", tasksRoute);
app.route("/runs", runsRoute);
app.route("/agents", agentsRoute);
app.route("/webhook", webhookRoute);
app.route("/plans", plansRoute);
app.route("/judgements", judgementsRoute);
app.route("/logs", logsRoute);
app.route("/config", configRoute);
app.route("/system", systemRoute);

// ルートパス
app.get("/", (c) => {
  return c.json({
    name: "openTiger",
    version: "0.1.0",
    description: "AI Agent Orchestration System",
  });
});

// Switch port via environment variable to avoid conflicts with target API
const port = parseInt(
  process.env.OPENTIGER_API_PORT ?? process.env.API_PORT ?? "4301",
  10,
);

console.log(`openTiger API server starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
