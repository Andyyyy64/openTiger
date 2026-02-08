import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@openTiger/db";
import { events, agents, runs, artifacts, tasks } from "@openTiger/db/schema";
import { eq, desc, and, inArray, gte, isNotNull, isNull } from "drizzle-orm";
import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import type { SystemState } from "../state-manager";
import { recordEvent } from "../monitors/index";
import type { CycleManagerConfig } from "./config";

type ReplanSignature = {
  signature: string;
  requirementHash: string;
  repoHeadSha: string;
};

type ReplanDecision = {
  shouldRun: boolean;
  signature?: ReplanSignature;
  reason?: string;
};

const SHELL_CONTROL_PATTERN = /&&|\|\||[|;&<>`]/;
let replanInProgress = false;
let lastReplanAt: number | null = null;
let warnedMissingRequirementPath = false;

export function isReplanInProgress(): boolean {
  return replanInProgress;
}

export function markReplanSkipped(): void {
  lastReplanAt = Date.now();
}

async function computeRequirementHash(requirementPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(requirementPath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    console.warn("[CycleManager] Failed to read requirement file:", error);
    return;
  }
}

async function fetchRepoHeadSha(repoUrl: string, baseBranch: string): Promise<string | undefined> {
  const token = process.env.GITHUB_TOKEN;
  const authenticatedUrl =
    token && repoUrl.startsWith("https://github.com/")
      ? repoUrl.replace("https://github.com/", `https://x-access-token:${token}@github.com/`)
      : repoUrl;

  return new Promise((resolveResult) => {
    const child = spawn("git", ["ls-remote", authenticatedUrl, baseBranch], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.warn("[CycleManager] git ls-remote failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }

      const sha = stdout.trim().split(/\s+/)[0];
      resolveResult(sha || undefined);
    });

    child.on("error", (error) => {
      console.warn("[CycleManager] git ls-remote error:", error);
      resolveResult(undefined);
    });
  });
}

async function fetchLocalHeadSha(workdir: string): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.warn("[CycleManager] git rev-parse failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }
      const sha = stdout.trim().split(/\s+/)[0];
      resolveResult(sha || undefined);
    });

    child.on("error", (error) => {
      console.warn("[CycleManager] git rev-parse error:", error);
      resolveResult(undefined);
    });
  });
}

async function computeReplanSignature(
  config: CycleManagerConfig,
): Promise<ReplanSignature | undefined> {
  // 要件とリポジトリの状態をまとめて署名し、差異判定に使う
  if (!config.replanRequirementPath) {
    return;
  }

  const requirementHash = await computeRequirementHash(config.replanRequirementPath);
  if (!requirementHash) {
    return;
  }

  const repoHeadSha = config.replanRepoUrl
    ? await fetchRepoHeadSha(config.replanRepoUrl, config.replanBaseBranch)
    : await fetchLocalHeadSha(config.replanWorkdir);
  if (!repoHeadSha) {
    console.warn("[CycleManager] Failed to resolve repo HEAD for replan signature.");
    return;
  }

  const repoIdentity = config.replanRepoUrl
    ? config.replanRepoUrl
    : `local:${resolve(config.replanWorkdir)}`;
  const signaturePayload = {
    requirementHash,
    repoHeadSha,
    repoUrl: repoIdentity,
    baseBranch: config.replanBaseBranch,
  };
  const signature = createHash("sha256").update(JSON.stringify(signaturePayload)).digest("hex");

  return {
    signature,
    requirementHash,
    repoHeadSha,
  };
}

function readPayloadField(payload: unknown, key: string): unknown | undefined {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (!(key in payload)) {
    return;
  }
  return (payload as Record<string, unknown>)[key];
}

async function getLastPlanSignature(): Promise<string | null> {
  try {
    const rows = await db
      .select({ payload: events.payload, type: events.type })
      .from(events)
      .where(inArray(events.type, ["planner.replan_finished", "planner.plan_created"]))
      .orderBy(desc(events.createdAt))
      .limit(10);

    for (const row of rows) {
      const payload = row.payload;
      if (row.type === "planner.replan_finished") {
        const exitCode = readPayloadField(payload, "exitCode");
        if (typeof exitCode === "number" && exitCode !== 0) {
          continue;
        }
      }
      const signature = readPayloadField(payload, "signature");
      if (typeof signature === "string") {
        return signature;
      }
    }

    return null;
  } catch (error) {
    console.warn("[CycleManager] Failed to load replan signature:", error);
    return null;
  }
}

async function getLastPlanCreatedAt(): Promise<Date | null> {
  try {
    const [row] = await db
      .select({ createdAt: events.createdAt })
      .from(events)
      .where(eq(events.type, "planner.plan_created"))
      .orderBy(desc(events.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  } catch (error) {
    console.warn("[CycleManager] Failed to load last plan event:", error);
    return null;
  }
}

export async function shouldTriggerReplan(
  state: SystemState,
  config: CycleManagerConfig,
): Promise<ReplanDecision> {
  if (!config.autoReplan || replanInProgress) {
    return { shouldRun: false, reason: "disabled_or_running" };
  }
  // Plannerが実行中なら再計画を避けて二重生成を防ぐ
  const [plannerBusy] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.role, "planner"), eq(agents.status, "busy")))
    .limit(1);
  if (plannerBusy) {
    return { shouldRun: false, reason: "planner_busy" };
  }
  const plannerRecentWindowRaw = Number.parseInt(
    process.env.REPLAN_PLANNER_ACTIVE_WINDOW_MS ?? "90000",
    10,
  );
  const plannerRecentWindowMs =
    Number.isFinite(plannerRecentWindowRaw) && plannerRecentWindowRaw > 0
      ? plannerRecentWindowRaw
      : 90000;
  const plannerRecentSince = new Date(Date.now() - plannerRecentWindowMs);
  const [plannerRecentlyActive] = await db
    .select({
      id: agents.id,
      status: agents.status,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(
      and(
        eq(agents.role, "planner"),
        isNotNull(agents.lastHeartbeat),
        gte(agents.lastHeartbeat, plannerRecentSince),
      ),
    )
    .orderBy(desc(agents.lastHeartbeat))
    .limit(1);
  if (plannerRecentlyActive) {
    return { shouldRun: false, reason: "planner_recently_active" };
  }
  if (!config.replanRequirementPath) {
    if (!warnedMissingRequirementPath) {
      console.warn("[CycleManager] REPLAN_REQUIREMENT_PATH is not set.");
      warnedMissingRequirementPath = true;
    }
    return { shouldRun: false, reason: "missing_requirement_path" };
  }
  const [pendingJudgeRun] = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(artifacts, eq(artifacts.runId, runs.id))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        inArray(artifacts.type, ["pr", "worktree"]),
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
      ),
    )
    .limit(1);
  if (pendingJudgeRun) {
    return { shouldRun: false, reason: "pending_judge_runs" };
  }
  // Judge待ちPR/blockedタスクが残っている間は再計画しない。
  // PR消化前の新規plan生成を防いで重複実行を避ける。
  if (state.tasks.blocked > 0) {
    return { shouldRun: false, reason: "blocked_tasks_present" };
  }
  if (state.tasks.queued > 0 || state.tasks.running > 0) {
    return { shouldRun: false, reason: "tasks_in_progress" };
  }
  const lastPlanAt = await getLastPlanCreatedAt();
  const nowMs = Date.now();
  const planAgeMs = lastPlanAt ? nowMs - lastPlanAt.getTime() : null;
  // 直近のPlanがあれば同一間隔内の再計画を避ける
  if (lastPlanAt && planAgeMs !== null && planAgeMs < config.replanIntervalMs) {
    console.log("[CycleManager] Skip replan: recent plan exists", {
      lastPlanAt: lastPlanAt.toISOString(),
      planAgeMs,
      intervalMs: config.replanIntervalMs,
    });
    return { shouldRun: false, reason: "recent_plan" };
  }
  // デバッグ: 再計画判定の状態をログ
  console.log("[CycleManager] Replan check", {
    lastPlanAt: lastPlanAt?.toISOString() ?? "none",
    planAgeMs,
    intervalMs: config.replanIntervalMs,
    replanInProgress,
  });
  if (lastReplanAt && Date.now() - lastReplanAt < config.replanIntervalMs) {
    return { shouldRun: false, reason: "interval" };
  }

  const signature = await computeReplanSignature(config);
  const skipSameSignature = process.env.REPLAN_SKIP_SAME_SIGNATURE === "true";
  if (skipSameSignature && signature) {
    // 直近の成功時と同じ署名なら差異がないので再計画しない
    const lastSignature = await getLastPlanSignature();
    if (lastSignature && lastSignature === signature.signature) {
      return { shouldRun: false, signature, reason: "no_diff" };
    }
  }

  return { shouldRun: true, signature };
}

type ParsedCommand = {
  executable: string;
  args: string[];
};

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (SHELL_CONTROL_PATTERN.test(trimmed)) {
    return null;
  }
  const tokens = tokenizeCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  const [executable, ...args] = tokens;
  if (!executable) {
    return null;
  }
  return { executable, args };
}

function buildReplanCommand(config: CycleManagerConfig): ParsedCommand | null {
  const parsed = parseCommand(config.replanCommand);
  if (!parsed) {
    return null;
  }
  const requirementPath = resolve(config.replanRequirementPath ?? "");
  return {
    executable: parsed.executable,
    args: [...parsed.args, requirementPath],
  };
}

function buildPlannerReplanEnv(config: CycleManagerConfig): Record<string, string> {
  const repoUrl = config.replanRepoUrl?.trim() || process.env.REPO_URL?.trim() || "";
  const baseBranch = config.replanBaseBranch?.trim() || process.env.BASE_BRANCH?.trim() || "main";
  const useRemote = repoUrl.length > 0;

  const env: Record<string, string> = {
    ...process.env,
    REPLAN_TRIGGERED_BY: "cycle-manager",
    BASE_BRANCH: baseBranch,
  };

  if (useRemote) {
    env.REPO_MODE = "git";
    env.REPO_URL = repoUrl;
    env.PLANNER_USE_REMOTE = "true";
    env.PLANNER_REPO_URL = repoUrl;
  }

  return env;
}

export async function triggerReplan(
  state: SystemState,
  signature: ReplanSignature | undefined,
  config: CycleManagerConfig,
): Promise<void> {
  // 競合状態防止: 既に実行中なら何もしない
  if (replanInProgress) {
    console.log("[CycleManager] triggerReplan called but already in progress, skipping");
    return;
  }

  if (!config.replanRequirementPath) {
    return;
  }

  const command = buildReplanCommand(config);
  if (!command) {
    await recordEvent({
      type: "planner.replan_failed",
      entityType: "system",
      entityId: SYSTEM_ENTITY_ID,
      payload: {
        error: "Invalid REPLAN_COMMAND. Shell operators are not allowed.",
      },
    });
    return;
  }
  const plannerEnv = buildPlannerReplanEnv(config);
  replanInProgress = true;
  lastReplanAt = Date.now();

  console.log(
    `[CycleManager] Triggering planner: ${[command.executable, ...command.args].join(" ")}`,
  );
  if (plannerEnv.PLANNER_REPO_URL) {
    console.log(
      `[CycleManager] Replan planner env: REPO_MODE=${plannerEnv.REPO_MODE}, PLANNER_USE_REMOTE=${plannerEnv.PLANNER_USE_REMOTE}, PLANNER_REPO_URL=${plannerEnv.PLANNER_REPO_URL}`,
    );
  }
  await recordEvent({
    type: "planner.replan_triggered",
    entityType: "system",
    entityId: SYSTEM_ENTITY_ID,
    payload: {
      reason: "tasks_empty",
      requirementPath: resolve(config.replanRequirementPath),
      tasks: state.tasks,
      signature: signature?.signature,
      requirementHash: signature?.requirementHash,
      repoHeadSha: signature?.repoHeadSha,
    },
  });

  const child = spawn(command.executable, command.args, {
    cwd: config.replanWorkdir,
    env: plannerEnv,
  });

  // Plannerの標準出力をそのまま流す
  child.stdout.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });
  child.stderr.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });

  child.on("close", (code) => {
    replanInProgress = false;
    const exitCode = code ?? -1;
    if (exitCode !== 0) {
      console.error(`[CycleManager] Planner exited with code ${exitCode}`);
    }
    void recordEvent({
      type: "planner.replan_finished",
      entityType: "system",
      entityId: SYSTEM_ENTITY_ID,
      payload: {
        exitCode,
        signature: signature?.signature,
        requirementHash: signature?.requirementHash,
        repoHeadSha: signature?.repoHeadSha,
      },
    });
  });

  child.on("error", (error) => {
    replanInProgress = false;
    console.error("[CycleManager] Planner spawn error:", error);
    void recordEvent({
      type: "planner.replan_failed",
      entityType: "system",
      entityId: SYSTEM_ENTITY_ID,
      payload: {
        error: error.message,
      },
    });
  });
}
