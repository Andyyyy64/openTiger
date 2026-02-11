import type { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@openTiger/db";
import { agents, leases, runs, tasks } from "@openTiger/db/schema";
import { ensureConfigRow } from "../../config-store";
import { getAuthInfo } from "../../middleware/index";
import { buildPreflightSummary, parseBooleanSetting, parseCountSetting } from "../system-preflight";
import { canControlSystem } from "../system-auth";
import { listProcessDefinitions, resolveProcessDefinition } from "./definitions";
import {
  buildProcessInfo,
  forceTerminateUnmanagedSystemProcesses,
  startManagedProcess,
  stopManagedProcess,
} from "./runtime";
import { managedProcesses, processStartLocks } from "./state";
import type { ProcessRuntime, StartPayload } from "./types";

const AGENT_LIVENESS_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_AGENT_LIVENESS_WINDOW_MS ?? "120000",
  10,
);
const PROCESS_SELF_HEAL_ENABLED = process.env.SYSTEM_PROCESS_SELF_HEAL !== "false";
const PROCESS_SELF_HEAL_INTERVAL_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS ?? "30000",
  10,
);
const PROCESS_SELF_HEAL_STARTUP_GRACE_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS ?? "120000",
  10,
);

let processSelfHealTimer: NodeJS.Timeout | null = null;
let processSelfHealInFlight = false;

type ConfigRow = Awaited<ReturnType<typeof ensureConfigRow>>;

function resolveBoundAgentId(processName: string): string | null {
  if (processName === "planner") {
    return "planner-1";
  }
  if (processName === "judge") {
    return "judge-1";
  }
  if (/^(judge|worker|tester|docser)-\d+$/.test(processName)) {
    return processName;
  }
  return null;
}

async function detectLiveBoundAgent(processName: string): Promise<{
  alive: boolean;
  agentId?: string;
  lastHeartbeat?: string;
}> {
  const agentId = resolveBoundAgentId(processName);
  if (!agentId) {
    return { alive: false };
  }

  const [agent] = await db
    .select({
      id: agents.id,
      status: agents.status,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent?.lastHeartbeat) {
    return { alive: false, agentId };
  }

  const livenessWindowMs =
    Number.isFinite(AGENT_LIVENESS_WINDOW_MS) && AGENT_LIVENESS_WINDOW_MS > 0
      ? AGENT_LIVENESS_WINDOW_MS
      : 120000;
  const alive =
    agent.status !== "offline" && agent.lastHeartbeat.getTime() >= Date.now() - livenessWindowMs;

  return {
    alive,
    agentId,
    lastHeartbeat: agent.lastHeartbeat.toISOString(),
  };
}

function resolveExpectedManagedProcessNames(configRow: ConfigRow): string[] {
  const processNames = new Set<string>();
  const dispatcherEnabled = parseBooleanSetting(configRow.dispatcherEnabled, true);
  const cycleManagerEnabled = parseBooleanSetting(configRow.cycleManagerEnabled, true);
  const judgeEnabled = parseBooleanSetting(configRow.judgeEnabled, true);

  if (dispatcherEnabled) {
    processNames.add("dispatcher");
  }
  if (cycleManagerEnabled) {
    processNames.add("cycle-manager");
  }
  if (judgeEnabled) {
    const judgeCount = parseCountSetting(configRow.judgeCount, 1);
    for (let index = 1; index <= judgeCount; index += 1) {
      processNames.add(index === 1 ? "judge" : `judge-${index}`);
    }
  }

  if (dispatcherEnabled) {
    const workerCount = parseCountSetting(configRow.workerCount, 1);
    const testerCount = parseCountSetting(configRow.testerCount, 1);
    const docserCount = parseCountSetting(configRow.docserCount, 1);
    for (let index = 1; index <= workerCount; index += 1) {
      processNames.add(`worker-${index}`);
    }
    for (let index = 1; index <= testerCount; index += 1) {
      processNames.add(`tester-${index}`);
    }
    for (let index = 1; index <= docserCount; index += 1) {
      processNames.add(`docser-${index}`);
    }
  }

  return Array.from(processNames.values());
}

function shouldSkipSelfHeal(runtime: ProcessRuntime | undefined): boolean {
  if (!runtime) {
    return false;
  }
  return runtime.stopRequested === true;
}

async function ensureProcessHealthy(processName: string): Promise<void> {
  const definition = resolveProcessDefinition(processName);
  if (!definition || !definition.autoRestart) {
    return;
  }

  const runtime = managedProcesses.get(definition.name);
  if (shouldSkipSelfHeal(runtime)) {
    return;
  }

  const discoveredAgent = await detectLiveBoundAgent(processName);
  if (discoveredAgent.alive) {
    if (!runtime || runtime.status !== "running") {
      managedProcesses.set(definition.name, {
        ...(runtime ?? { status: "running" as const }),
        status: "running",
        stopRequested: false,
        finishedAt: undefined,
        exitCode: null,
        signal: null,
        message:
          `Detected existing live agent ${discoveredAgent.agentId}` +
          (discoveredAgent.lastHeartbeat
            ? ` (heartbeat=${discoveredAgent.lastHeartbeat})`
            : ""),
      });
    }
    return;
  }

  const now = Date.now();
  const startupGraceMs =
    Number.isFinite(PROCESS_SELF_HEAL_STARTUP_GRACE_MS) && PROCESS_SELF_HEAL_STARTUP_GRACE_MS >= 0
      ? PROCESS_SELF_HEAL_STARTUP_GRACE_MS
      : 120000;
  const startedAtMs = runtime?.startedAt ? Date.parse(runtime.startedAt) : Number.NaN;
  const withinStartupGrace =
    Number.isFinite(startedAtMs) && now - startedAtMs < startupGraceMs && runtime?.status === "running";
  if (withinStartupGrace) {
    return;
  }

  // process は生きているが heartbeat が落ちているケースでは、強制的に再起動して復旧させる
  if (runtime?.status === "running" && runtime.process && !runtime.stopRequested) {
    stopManagedProcess(definition);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await startManagedProcess(definition, {});
}

async function runProcessSelfHealTick(): Promise<void> {
  if (!PROCESS_SELF_HEAL_ENABLED) {
    return;
  }
  if (processSelfHealInFlight) {
    return;
  }
  processSelfHealInFlight = true;
  try {
    const configRow = await ensureConfigRow();
    const expectedProcesses = resolveExpectedManagedProcessNames(configRow);
    for (const processName of expectedProcesses) {
      try {
        await ensureProcessHealthy(processName);
      } catch (error) {
        console.error(`[System] Self-heal failed for ${processName}:`, error);
      }
    }
  } catch (error) {
    console.error("[System] Self-heal tick failed:", error);
  } finally {
    processSelfHealInFlight = false;
  }
}

function startProcessSelfHealLoop(): void {
  if (!PROCESS_SELF_HEAL_ENABLED || processSelfHealTimer) {
    return;
  }
  const intervalMs =
    Number.isFinite(PROCESS_SELF_HEAL_INTERVAL_MS) && PROCESS_SELF_HEAL_INTERVAL_MS > 0
      ? PROCESS_SELF_HEAL_INTERVAL_MS
      : 30000;
  processSelfHealTimer = setInterval(() => {
    void runProcessSelfHealTick();
  }, intervalMs);
  if (typeof processSelfHealTimer.unref === "function") {
    processSelfHealTimer.unref();
  }
  void runProcessSelfHealTick();
}

// APIルートの公開窓口
export function registerProcessManagerRoutes(systemRoute: Hono): void {
  startProcessSelfHealLoop();

  systemRoute.get("/processes", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const processes = listProcessDefinitions().map((definition) =>
      buildProcessInfo(definition, managedProcesses.get(definition.name)),
    );
    return c.json({ processes });
  });

  systemRoute.get("/processes/:name", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }
    const info = buildProcessInfo(definition, managedProcesses.get(definition.name));
    return c.json({ process: info });
  });

  systemRoute.post("/processes/:name/start", async (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }

    const discoveredAgent = await detectLiveBoundAgent(name);
    if (discoveredAgent.alive) {
      const existingRuntime = managedProcesses.get(definition.name);
      const runtime: ProcessRuntime = {
        ...(existingRuntime ?? { status: "running" as const }),
        status: "running",
        finishedAt: undefined,
        exitCode: null,
        signal: null,
        stopRequested: false,
        message:
          `Detected existing live agent ${discoveredAgent.agentId}` +
          (discoveredAgent.lastHeartbeat ? ` (heartbeat=${discoveredAgent.lastHeartbeat})` : ""),
      };
      managedProcesses.set(definition.name, runtime);
      return c.json({
        process: buildProcessInfo(definition, runtime),
        alreadyRunning: true,
        discovered: true,
      });
    }

    const runtimeKey = definition.name;
    const existing = managedProcesses.get(runtimeKey);
    const shouldRejectDuplicateStart = definition.kind === "planner";
    if (shouldRejectDuplicateStart) {
      // Planner tends to save multiple plans from the same requirement when started multiple times, so exclude duplicate start requests
      if (existing?.status === "running" && existing.process) {
        return c.json(
          {
            error: "Planner already running",
            process: buildProcessInfo(definition, existing),
          },
          409,
        );
      }
      if (processStartLocks.has(runtimeKey)) {
        return c.json(
          {
            error: "Planner start already in progress",
            process: buildProcessInfo(definition, managedProcesses.get(runtimeKey)),
          },
          409,
        );
      }
      processStartLocks.add(runtimeKey);
    } else if (existing?.status === "running" && existing.process) {
      return c.json({
        process: buildProcessInfo(definition, existing),
        alreadyRunning: true,
      });
    }

    try {
      const rawBody = await c.req.json().catch(() => ({}));
      const rawContent = typeof rawBody?.content === "string" ? rawBody.content : undefined;
      if (rawContent !== undefined && rawContent.trim().length === 0) {
        return c.json({ error: "Requirement content is empty" }, 400);
      }
      if (definition.kind === "planner") {
        const configRow = await ensureConfigRow();
        const preflight = await buildPreflightSummary({
          configRow,
          autoCreateIssueTasks: false,
          autoCreatePrJudgeTasks: false,
        });
        const hasLocalTaskBacklog =
          preflight.local.queuedTaskCount > 0 ||
          preflight.local.runningTaskCount > 0 ||
          preflight.local.failedTaskCount > 0 ||
          preflight.local.blockedTaskCount > 0;
        if (hasLocalTaskBacklog) {
          return c.json(
            {
              error:
                "Planner start blocked: local task backlog exists " +
                `(queued=${preflight.local.queuedTaskCount}, running=${preflight.local.runningTaskCount}, failed=${preflight.local.failedTaskCount}, blocked=${preflight.local.blockedTaskCount}). ` +
                "Clear task backlog first.",
            },
            409,
          );
        }
        const hasIssueBacklog = preflight.github.issueTaskBacklogCount > 0;
        if (hasIssueBacklog) {
          return c.json(
            {
              error:
                "Planner start blocked: open issue backlog exists " +
                `(issueBacklog=${preflight.github.issueTaskBacklogCount}). ` +
                "Process issue backlog first.",
            },
            409,
          );
        }
        const hasJudgeBacklog =
          preflight.github.openPrCount > 0 || preflight.local.pendingJudgeTaskCount > 0;
        if (hasJudgeBacklog) {
          return c.json(
            {
              error:
                `Planner start blocked: pending PR/judge backlog exists ` +
                `(openPR=${preflight.github.openPrCount}, awaitingJudge=${preflight.local.pendingJudgeTaskCount}). ` +
                "Start judge first and clear PR backlog.",
            },
            409,
          );
        }
      }
      const payload: StartPayload = {
        requirementPath:
          typeof rawBody?.requirementPath === "string" ? rawBody.requirementPath : undefined,
        content: rawContent,
      };
      const processInfo = await startManagedProcess(definition, payload);
      return c.json({ process: processInfo });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start process";
      return c.json({ error: message }, 400);
    } finally {
      if (shouldRejectDuplicateStart) {
        processStartLocks.delete(runtimeKey);
      }
    }
  });

  systemRoute.post("/processes/:name/stop", (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const name = c.req.param("name");
    const definition = resolveProcessDefinition(name);
    if (!definition) {
      return c.json({ error: "Process not found" }, 404);
    }

    if (!definition.supportsStop) {
      return c.json({ error: "Process cannot be stopped" }, 400);
    }

    const info = stopManagedProcess(definition);
    return c.json({ process: info });
  });

  systemRoute.post("/processes/stop-all", async (c) => {
    const auth = getAuthInfo(c);
    if (!canControlSystem(auth.method)) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const stopped: string[] = [];
    const skipped: string[] = [];

    for (const definition of listProcessDefinitions()) {
      // Only stop processes other than ui and server
      // ui and server are started by pnpm run up and are not managed by system.ts
      if (
        definition.name === "ui" ||
        definition.name === "server" ||
        definition.name === "dashboard" ||
        definition.name === "api"
      ) {
        continue;
      }

      if (!definition.supportsStop) {
        skipped.push(definition.name);
        continue;
      }

      const runtime = managedProcesses.get(definition.name);
      if (runtime) {
        stopManagedProcess(definition);
        stopped.push(definition.name);
      } else {
        skipped.push(definition.name);
      }
    }

    let cancelledRuns = 0;
    let requeuedTasks = 0;
    let orphanCleanup = { matched: 0, signaled: 0, killed: 0, pids: [] as number[] };
    try {
      orphanCleanup = await forceTerminateUnmanagedSystemProcesses();

      const runningRows = await db
        .select({
          runId: runs.id,
          taskId: runs.taskId,
        })
        .from(runs)
        .where(eq(runs.status, "running"));

      if (runningRows.length > 0) {
        const runningRunIds = runningRows.map((row) => row.runId);
        const runningTaskIds = Array.from(new Set(runningRows.map((row) => row.taskId)));

        cancelledRuns = runningRunIds.length;
        requeuedTasks = runningTaskIds.length;

        await db
          .update(runs)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            errorMessage: "System stop-all requested",
          })
          .where(inArray(runs.id, runningRunIds));

        await db
          .update(tasks)
          .set({
            status: "queued",
            blockReason: null,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.status, "running"), inArray(tasks.id, runningTaskIds)));

        await db.delete(leases).where(inArray(leases.taskId, runningTaskIds));
      }

      await db
        .update(agents)
        .set({
          status: "offline",
          currentTaskId: null,
          lastHeartbeat: new Date(),
        })
        .where(
          inArray(agents.role, [
            "planner",
            "judge",
            "worker",
            "tester",
            "docser",
            "dispatcher",
            "cycle-manager",
          ]),
        );

      // stop-all 直後に自動復旧ループが即時再起動しないよう、対象プロセスを明示停止状態として記録
      const configRow = await ensureConfigRow();
      const expectedProcesses = resolveExpectedManagedProcessNames(configRow);
      for (const processName of expectedProcesses) {
        const definition = resolveProcessDefinition(processName);
        if (!definition) {
          continue;
        }
        const current = managedProcesses.get(definition.name);
        managedProcesses.set(definition.name, {
          ...(current ?? { status: "stopped" }),
          status: "stopped",
          stopRequested: true,
          process: null,
          finishedAt: new Date().toISOString(),
          message: "Stopped by stop-all",
          restartScheduled: false,
          restartTimer: undefined,
        });
      }
    } catch (error) {
      console.error("[System] stop-all cleanup failed:", error);
    }

    return c.json({
      stopped,
      skipped,
      orphanCleanup,
      cancelledRuns,
      requeuedTasks,
      message: `Stopped ${stopped.length} process(es)`,
    });
  });
}
