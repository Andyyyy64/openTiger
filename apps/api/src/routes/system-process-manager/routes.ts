import type { Hono } from "hono";
import { and, desc, eq, gte, inArray, not } from "drizzle-orm";
import { db } from "@openTiger/db";
import { agents, config as configTable, events, leases, runs, tasks } from "@openTiger/db/schema";
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
const CANONICAL_REQUIREMENT_PATH = "docs/requirement.md";
const RUNTIME_HATCH_ENTITY_ID = "00000000-0000-0000-0000-000000000001";
const RUNTIME_HATCH_ARMED_EVENT = "system.runtime_hatch_armed";
const RUNTIME_HATCH_DISARMED_EVENT = "system.runtime_hatch_disarmed";
const RUNTIME_HATCH_ARMING_KINDS = new Set(["planner", "service", "worker"]);

let processSelfHealTimer: NodeJS.Timeout | null = null;
let processSelfHealInFlight = false;
let runtimeHatchArmed = false;
let runtimeHatchLoaded = false;
let runtimeHatchLoadPromise: Promise<void> | null = null;

type ConfigRow = Awaited<ReturnType<typeof ensureConfigRow>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureRuntimeHatchStateLoaded(): Promise<void> {
  if (runtimeHatchLoaded) {
    return;
  }
  if (!runtimeHatchLoadPromise) {
    runtimeHatchLoadPromise = (async () => {
      const [latest] = await db
        .select({ type: events.type })
        .from(events)
        .where(
          and(
            eq(events.entityType, "system"),
            eq(events.entityId, RUNTIME_HATCH_ENTITY_ID),
            inArray(events.type, [RUNTIME_HATCH_ARMED_EVENT, RUNTIME_HATCH_DISARMED_EVENT]),
          ),
        )
        .orderBy(desc(events.createdAt))
        .limit(1);
      runtimeHatchArmed = latest?.type === RUNTIME_HATCH_ARMED_EVENT;
      runtimeHatchLoaded = true;
    })().finally(() => {
      runtimeHatchLoadPromise = null;
    });
  }
  await runtimeHatchLoadPromise;
}

async function setRuntimeHatchArmed(
  armed: boolean,
  payload?: Record<string, unknown>,
): Promise<void> {
  await ensureRuntimeHatchStateLoaded();
  if (runtimeHatchArmed === armed) {
    return;
  }
  runtimeHatchArmed = armed;
  await db.insert(events).values({
    type: armed ? RUNTIME_HATCH_ARMED_EVENT : RUNTIME_HATCH_DISARMED_EVENT,
    entityType: "system",
    entityId: RUNTIME_HATCH_ENTITY_ID,
    payload: payload ?? {},
  });
}

function shouldArmRuntimeHatchOnStart(kind: string): boolean {
  return RUNTIME_HATCH_ARMING_KINDS.has(kind);
}

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

async function hasLiveExecutionAgents(): Promise<boolean> {
  const livenessWindowMs =
    Number.isFinite(AGENT_LIVENESS_WINDOW_MS) && AGENT_LIVENESS_WINDOW_MS > 0
      ? AGENT_LIVENESS_WINDOW_MS
      : 120000;
  const threshold = new Date(Date.now() - livenessWindowMs);
  const [liveAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        inArray(agents.role, ["judge", "worker", "tester", "docser"]),
        not(eq(agents.status, "offline")),
        gte(agents.lastHeartbeat, threshold),
      ),
    )
    .limit(1);
  return Boolean(liveAgent?.id);
}

function resolveExpectedManagedProcessNames(configRow: ConfigRow): string[] {
  if (!runtimeHatchArmed) {
    return [];
  }
  const processNames = new Set<string>();
  const dispatcherEnabled = parseBooleanSetting(configRow.dispatcherEnabled, true);
  const cycleManagerEnabled = parseBooleanSetting(configRow.cycleManagerEnabled, true);
  const judgeEnabled = parseBooleanSetting(configRow.judgeEnabled, true);
  const executionEnvironment = (configRow.executionEnvironment ?? "host").trim().toLowerCase();
  const sandboxExecution = executionEnvironment === "sandbox";

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

  if (dispatcherEnabled && !sandboxExecution) {
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

async function hasRunningRunForAgent(agentId: string): Promise<boolean> {
  const [runningRun] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")))
    .limit(1);
  return Boolean(runningRun?.id);
}

function resolveSourceTaskIdFromTaskContext(taskContext: unknown): string | null {
  if (!isRecord(taskContext)) {
    return null;
  }
  const pr = taskContext.pr;
  if (!isRecord(pr)) {
    return null;
  }
  const raw = pr.sourceTaskId;
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

async function cancelRunningWorkForAgent(agentId: string, reason: string): Promise<void> {
  const runningRows = await db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
    })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")));

  if (runningRows.length === 0) {
    await db
      .update(agents)
      .set({
        status: "offline",
        currentTaskId: null,
        lastHeartbeat: new Date(),
      })
      .where(eq(agents.id, agentId));
    return;
  }

  const runningRunIds = runningRows.map((row) => row.runId);
  const runningTaskIds = Array.from(new Set(runningRows.map((row) => row.taskId)));
  const sourceTaskIds = new Set<string>();

  const runningTasks = await db
    .select({
      id: tasks.id,
      context: tasks.context,
    })
    .from(tasks)
    .where(inArray(tasks.id, runningTaskIds));
  for (const task of runningTasks) {
    const sourceTaskId = resolveSourceTaskIdFromTaskContext(task.context);
    if (sourceTaskId) {
      sourceTaskIds.add(sourceTaskId);
    }
  }

  await db
    .update(runs)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      errorMessage: reason,
    })
    .where(inArray(runs.id, runningRunIds));

  await db
    .update(tasks)
    .set({
      status: "cancelled",
      blockReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.status, "running"), inArray(tasks.id, runningTaskIds)));

  if (sourceTaskIds.size > 0) {
    await db
      .update(tasks)
      .set({
        status: "cancelled",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(tasks.id, Array.from(sourceTaskIds)),
          inArray(tasks.status, ["queued", "running", "blocked", "failed"]),
        ),
      );
  }

  await db.delete(leases).where(inArray(leases.taskId, runningTaskIds));

  await db
    .update(agents)
    .set({
      status: "offline",
      currentTaskId: null,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
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

  const boundAgentId = resolveBoundAgentId(processName);
  if (!boundAgentId) {
    // Processes without agent heartbeat (e.g. dispatcher/cycle-manager) are not restarted if running
    if (runtime?.status === "running") {
      return;
    }
    await startManagedProcess(definition, {});
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
          (discoveredAgent.lastHeartbeat ? ` (heartbeat=${discoveredAgent.lastHeartbeat})` : ""),
      });
    }
    return;
  }

  const hasRunningRun = await hasRunningRunForAgent(boundAgentId);
  if (hasRunningRun && runtime?.status === "running") {
    // Do not kill process while tasks are running to avoid job interruption
    return;
  }

  const now = Date.now();
  const startupGraceMs =
    Number.isFinite(PROCESS_SELF_HEAL_STARTUP_GRACE_MS) && PROCESS_SELF_HEAL_STARTUP_GRACE_MS >= 0
      ? PROCESS_SELF_HEAL_STARTUP_GRACE_MS
      : 120000;
  const startedAtMs = runtime?.startedAt ? Date.parse(runtime.startedAt) : Number.NaN;
  const withinStartupGrace =
    Number.isFinite(startedAtMs) &&
    now - startedAtMs < startupGraceMs &&
    runtime?.status === "running";
  if (withinStartupGrace) {
    return;
  }

  // If process is alive but heartbeat is down, force restart to recover
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
  await ensureRuntimeHatchStateLoaded();
  if (processSelfHealInFlight) {
    return;
  }
  processSelfHealInFlight = true;
  try {
    const configRow = await ensureConfigRow();
    const hasLiveAgents = await hasLiveExecutionAgents();
    if (hasLiveAgents && !runtimeHatchArmed) {
      await setRuntimeHatchArmed(true, {
        source: "system.self_heal.live_execution_agent",
      });
    }
    const expectedSet = new Set(resolveExpectedManagedProcessNames(configRow));
    const expectedProcesses = Array.from(expectedSet.values());
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

// API route entry point
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
    if (shouldArmRuntimeHatchOnStart(definition.kind)) {
      try {
        await setRuntimeHatchArmed(true, {
          source: "system.process.start",
          process: definition.name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to arm runtime hatch";
        return c.json({ error: message }, 500);
      }
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
      const rawResearchJobId =
        typeof rawBody?.researchJobId === "string" ? rawBody.researchJobId.trim() : undefined;
      if (rawContent !== undefined && rawContent.trim().length === 0) {
        return c.json({ error: "Requirement content is empty" }, 400);
      }
      const plannerResearchMode = Boolean(rawResearchJobId);
      if (definition.kind === "planner" && !plannerResearchMode) {
        const configRow = await ensureConfigRow();
        if (rawContent && configRow.replanRequirementPath.trim() !== CANONICAL_REQUIREMENT_PATH) {
          await db
            .update(configTable)
            .set({
              replanRequirementPath: CANONICAL_REQUIREMENT_PATH,
              updatedAt: new Date(),
            })
            .where(eq(configTable.id, configRow.id));
        }
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
        researchJobId: rawResearchJobId,
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

  systemRoute.post("/processes/:name/stop", async (c) => {
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
    const boundAgentId = resolveBoundAgentId(name);
    if (boundAgentId) {
      try {
        await cancelRunningWorkForAgent(boundAgentId, "Stopped via system process stop request");
      } catch (error) {
        console.error(`[System] Failed to cancel running work for ${boundAgentId}:`, error);
      }
    }
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

      // Record process as explicitly stopped so auto-recovery does not restart immediately after stop-all
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
    try {
      await setRuntimeHatchArmed(false, {
        source: "system.process.stop-all",
      });
    } catch (error) {
      console.error("[System] Failed to disarm runtime hatch after stop-all:", error);
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
