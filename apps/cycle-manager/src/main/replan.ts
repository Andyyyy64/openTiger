import { spawn, spawnSync } from "node:child_process";
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
const UNBORN_HEAD_SIGNATURE = "__UNBORN_HEAD__";
let replanInProgress = false;
let lastReplanAt: number | null = null;
let warnedMissingRequirementPath = false;
const JUDGE_ARTIFACT_TYPES: string[] = [
  "pr",
  "worktree",
  "research_claim",
  "research_source",
  "research_report",
];

function isUnbornHeadError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("ambiguous argument 'head'") ||
    normalized.includes("unknown revision or path not in the working tree") ||
    normalized.includes("needed a single revision")
  );
}

function resolveGitHubAuthMode(rawValue: string | undefined): "gh" | "token" {
  return rawValue?.trim().toLowerCase() === "token" ? "token" : "gh";
}

function resolveGitHubToken(): string {
  const mode = resolveGitHubAuthMode(process.env.GITHUB_AUTH_MODE);
  if (mode === "token") {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "GitHub auth mode is 'token' but GITHUB_TOKEN is not set. Set GITHUB_TOKEN or switch GITHUB_AUTH_MODE to 'gh'.",
      );
    }
    return token;
  }

  const result = spawnSync("gh", ["auth", "token"], {
    env: process.env,
    encoding: "utf-8",
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(
        "GitHub auth mode is 'gh' but GitHub CLI is not installed. Install `gh` from https://cli.github.com/ and run `gh auth login`.",
      );
    }
    throw new Error(`Failed to execute \`gh auth token\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `GitHub auth mode is 'gh' but no authenticated session was found. Run \`gh auth login\`${detail ? ` (${detail})` : ""}.`,
    );
  }
  const token = result.stdout.trim();
  if (!token) {
    throw new Error(
      "GitHub auth mode is 'gh' but `gh auth token` returned an empty value. Re-run `gh auth login`.",
    );
  }
  return token;
}

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
  let authenticatedUrl = repoUrl;
  if (repoUrl.startsWith("https://github.com/")) {
    try {
      const token = resolveGitHubToken();
      authenticatedUrl = repoUrl.replace(
        "https://github.com/",
        `https://x-access-token:${token}@github.com/`,
      );
    } catch (error) {
      console.warn("[CycleManager] GitHub auth resolution failed:", error);
      return;
    }
  }

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
      if (!sha) {
        console.warn(
          "[CycleManager] Remote branch has no commits yet. Using placeholder for replan signature.",
        );
        resolveResult(UNBORN_HEAD_SIGNATURE);
        return;
      }
      resolveResult(sha);
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
        if (isUnbornHeadError(stderr)) {
          console.warn(
            "[CycleManager] Local repository has no commits yet. Using placeholder for replan signature.",
          );
          resolveResult(UNBORN_HEAD_SIGNATURE);
          return;
        }
        console.warn("[CycleManager] git rev-parse failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }
      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha) {
        console.warn(
          "[CycleManager] git rev-parse returned empty HEAD; using placeholder for replan signature.",
        );
        resolveResult(UNBORN_HEAD_SIGNATURE);
        return;
      }
      resolveResult(sha);
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
  // Sign requirement and repo state for diff detection
  if (!config.replanRequirementPath) {
    return;
  }

  const requirementHash = await computeRequirementHash(config.replanRequirementPath);
  if (!requirementHash) {
    return;
  }

  // Resolve repo HEAD for signature:
  // - github mode (repoUrl set): fetch remote HEAD via ls-remote
  // - local-git mode: fetch local HEAD from LOCAL_REPO_PATH (has git)
  // - direct mode: no git, use static placeholder (signature based on requirement hash only)
  let repoHeadSha: string | undefined;
  if (config.replanRepoUrl) {
    repoHeadSha = await fetchRepoHeadSha(config.replanRepoUrl, config.replanBaseBranch);
  } else {
    const repoMode = process.env.REPO_MODE?.trim().toLowerCase();
    if (repoMode === "direct") {
      repoHeadSha = "__DIRECT_MODE__";
    } else if (repoMode === "local-git" || repoMode === "local") {
      const localPath = process.env.LOCAL_REPO_PATH?.trim();
      repoHeadSha = await fetchLocalHeadSha(localPath || config.replanWorkdir);
    } else {
      repoHeadSha = await fetchLocalHeadSha(config.replanWorkdir);
    }
  }
  if (!repoHeadSha) {
    console.warn("[CycleManager] Failed to resolve repo HEAD for replan signature.");
    return;
  }

  const repoIdentity = config.replanRepoUrl
    ? config.replanRepoUrl
    : `local:${resolve(process.env.LOCAL_REPO_PATH?.trim() || config.replanWorkdir)}`;
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
  // Avoid replan while Planner is running to prevent duplicate generation
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
        inArray(artifacts.type, JUDGE_ARTIFACT_TYPES),
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
      ),
    )
    .limit(1);
  if (pendingJudgeRun) {
    return { shouldRun: false, reason: "pending_judge_runs" };
  }
  // Do not replan while PRs awaiting Judge or blocked tasks remain
  // Avoid new plan generation before PRs are consumed to prevent duplicate execution
  if (state.tasks.blocked > 0) {
    return { shouldRun: false, reason: "blocked_tasks_present" };
  }
  if (state.tasks.queued > 0 || state.tasks.running > 0) {
    return { shouldRun: false, reason: "tasks_in_progress" };
  }
  const lastPlanAt = await getLastPlanCreatedAt();
  const nowMs = Date.now();
  const planAgeMs = lastPlanAt ? nowMs - lastPlanAt.getTime() : null;
  // Skip replan within same interval if a recent Plan exists
  if (lastPlanAt && planAgeMs !== null && planAgeMs < config.replanIntervalMs) {
    console.log("[CycleManager] Skip replan: recent plan exists", {
      lastPlanAt: lastPlanAt.toISOString(),
      planAgeMs,
      intervalMs: config.replanIntervalMs,
    });
    return { shouldRun: false, reason: "recent_plan" };
  }
  // Debug: log replan decision state
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
    // No replan if signature matches last success (no diff)
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
  const baseBranch = config.replanBaseBranch?.trim() || process.env.BASE_BRANCH?.trim() || "main";

  const env: Record<string, string> = {
    ...process.env,
    REPLAN_TRIGGERED_BY: "cycle-manager",
    BASE_BRANCH: baseBranch,
  };

  // In direct/local-git modes, never override to remote git — use local workdir
  const repoMode = process.env.REPO_MODE?.trim().toLowerCase();
  if (repoMode === "direct" || repoMode === "local-git" || repoMode === "local") {
    return env;
  }

  const repoUrl = config.replanRepoUrl?.trim() || process.env.REPO_URL?.trim() || "";
  if (repoUrl.length > 0) {
    env.REPO_MODE = "github";
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
  // Prevent race: do nothing if already running
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

  // Stream Planner stdout directly
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
