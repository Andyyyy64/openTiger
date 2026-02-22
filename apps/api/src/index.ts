import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import { db } from "@openTiger/db";
import { events } from "@openTiger/db/schema";
import "dotenv/config";
import { tasksRoute } from "./routes/tasks";
import { runsRoute } from "./routes/runs";
import { agentsRoute } from "./routes/agents";
import { healthRoute } from "./routes/health";
import { webhookRoute } from "./routes/webhook";
import { plansRoute } from "./routes/plans";
import { judgementsRoute } from "./routes/judgements";
import { logsRoute } from "./routes/logs";
import { configRoute } from "./routes/config";
import { systemRoute } from "./routes/system";
import { authMiddleware, rateLimitMiddleware } from "./middleware/index";
import { resolveProcessDefinition } from "./routes/system-process-manager/definitions";
import { listApiPlugins, registerApiPlugins } from "./plugins";
import {
  forceTerminateUnmanagedSystemProcesses,
  stopManagedProcess,
} from "./routes/system-process-manager/runtime";
import { managedProcesses } from "./routes/system-process-manager/state";

setupProcessLogging(process.env.OPENTIGER_LOG_NAME ?? "api", { label: "API" });

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());
app.use("*", rateLimitMiddleware());
app.use("*", authMiddleware());

// Routes
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
registerApiPlugins(app);

// Root path
app.get("/", (c) => {
  return c.json({
    name: "openTiger",
    version: "0.1.0",
    description: "AI Agent Orchestration System",
  });
});

app.get("/plugins", (c) => {
  return c.json({
    plugins: listApiPlugins(),
  });
});

// Switch port via environment variable to avoid conflicts with target API
const port = parseInt(process.env.OPENTIGER_API_PORT ?? process.env.API_PORT ?? "4301", 10);
const RUNTIME_HATCH_ENTITY_ID = "00000000-0000-0000-0000-000000000001";
const RUNTIME_HATCH_DISARMED_EVENT = "system.runtime_hatch_disarmed";
let shuttingDown = false;
const PRESERVE_MANAGED_PROCESSES_ON_DEV_SIGTERM =
  process.env.OPENTIGER_PRESERVE_MANAGED_ON_DEV_SIGTERM !== "false";

console.log(`openTiger API server starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

async function disarmRuntimeHatchOnShutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await db.insert(events).values({
      type: RUNTIME_HATCH_DISARMED_EVENT,
      entityType: "system",
      entityId: RUNTIME_HATCH_ENTITY_ID,
      payload: {
        source: "api.signal_shutdown",
        signal,
      },
    });
  } catch (error) {
    console.error("[System] Failed to disarm runtime hatch during shutdown:", error);
  }
}

async function stopManagedProcessesOnShutdown(): Promise<void> {
  const targetNames = Array.from(managedProcesses.keys());
  for (const processName of targetNames) {
    const definition = resolveProcessDefinition(processName);
    if (!definition) {
      continue;
    }
    stopManagedProcess(definition);
  }

  // Exiting immediately after sending SIGTERM may leave detached child processes, so wait briefly then clean up orphans
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await forceTerminateUnmanagedSystemProcesses().catch((error) => {
    console.error("[System] Failed to terminate unmanaged processes during shutdown:", error);
  });
}

async function handleShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const inDevLifecycle = process.env.npm_lifecycle_event === "dev";
  const preserveManaged =
    signal === "SIGTERM" && inDevLifecycle && PRESERVE_MANAGED_PROCESSES_ON_DEV_SIGTERM;

  if (preserveManaged) {
    console.log(
      `[System] Received ${signal} in dev lifecycle. Preserving managed processes for hot-restart.`,
    );
    process.exit(0);
    return;
  }

  console.log(`[System] Received ${signal}. Stopping managed processes...`);
  await stopManagedProcessesOnShutdown();
  await disarmRuntimeHatchOnShutdown(signal);
  process.exit(0);
}

process.once("SIGINT", () => {
  void handleShutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void handleShutdown("SIGTERM");
});
