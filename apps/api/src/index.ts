import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import "dotenv/config";
import { tasksRoute } from "./routes/tasks.js";
import { runsRoute } from "./routes/runs.js";
import { agentsRoute } from "./routes/agents.js";
import { healthRoute } from "./routes/health.js";
import { webhookRoute } from "./routes/webhook.js";
import { authMiddleware, rateLimitMiddleware } from "./middleware/index.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.H1VE_LOG_DIR ?? "/tmp/h1ve-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${logName}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });

  // ターミナルが流れても追跡できるようにログをファイルに残す
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;

  process.on("exit", () => {
    stream.end();
  });

  console.log(`[Logger] API logs are written to ${logPath}`);
  return logPath;
}

setupProcessLogging(process.env.H1VE_LOG_NAME ?? "api");

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
