import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { ensureConfigRow } from "../config-store";
import { parseBooleanSetting } from "./system-preflight";
import { resolveProcessDefinition } from "./system-process-manager/definitions";
import { startManagedProcess } from "./system-process-manager/runtime";
import { managedProcesses } from "./system-process-manager/state";

type EnsureRuntimeResult = {
  started: string[];
  skipped: string[];
  errors: string[];
};

const AGENT_LIVENESS_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_AGENT_LIVENESS_WINDOW_MS ?? "120000",
  10,
);

function getAgentLivenessWindowMs(): number {
  return Number.isFinite(AGENT_LIVENESS_WINDOW_MS) && AGENT_LIVENESS_WINDOW_MS > 0
    ? AGENT_LIVENESS_WINDOW_MS
    : 120000;
}

async function hasLiveAgentRole(role: "worker" | "judge"): Promise<boolean> {
  const threshold = new Date(Date.now() - getAgentLivenessWindowMs());
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.role, role),
        inArray(agents.status, ["idle", "busy"]),
        gte(agents.lastHeartbeat, threshold),
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

async function ensureProcessStarted(name: string, result: EnsureRuntimeResult): Promise<void> {
  const definition = resolveProcessDefinition(name);
  if (!definition) {
    result.errors.push(`${name}: process definition not found`);
    return;
  }

  const runtime = managedProcesses.get(definition.name);
  if (runtime?.status === "running") {
    result.skipped.push(name);
    return;
  }

  try {
    await startManagedProcess(definition, {});
    result.started.push(name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`${name}: ${message}`);
  }
}

function requiresResearchJudge(): boolean {
  return (process.env.RESEARCH_REQUIRE_JUDGE ?? "false").toLowerCase() === "true";
}

export async function ensureResearchRuntimeStarted(): Promise<EnsureRuntimeResult> {
  const result: EnsureRuntimeResult = {
    started: [],
    skipped: [],
    errors: [],
  };

  const configRow = await ensureConfigRow();
  const dispatcherEnabled = parseBooleanSetting(configRow.dispatcherEnabled, true);
  const cycleManagerEnabled = parseBooleanSetting(configRow.cycleManagerEnabled, true);
  const judgeEnabled = parseBooleanSetting(configRow.judgeEnabled, true);
  const executionEnvironment = (configRow.executionEnvironment ?? "host").trim().toLowerCase();
  const sandboxExecution = executionEnvironment === "sandbox";

  if (dispatcherEnabled) {
    await ensureProcessStarted("dispatcher", result);
  } else {
    result.skipped.push("dispatcher(disabled)");
  }

  if (cycleManagerEnabled) {
    await ensureProcessStarted("cycle-manager", result);
  } else {
    result.skipped.push("cycle-manager(disabled)");
  }

  if (!sandboxExecution) {
    const hasWorker = await hasLiveAgentRole("worker");
    if (hasWorker) {
      result.skipped.push("worker(live)");
    } else {
      await ensureProcessStarted("worker-1", result);
    }
  } else {
    result.skipped.push("worker(sandbox_execution)");
  }

  if (judgeEnabled && requiresResearchJudge()) {
    const hasJudge = await hasLiveAgentRole("judge");
    if (hasJudge) {
      result.skipped.push("judge(live)");
    } else {
      await ensureProcessStarted("judge", result);
    }
  }

  return result;
}
