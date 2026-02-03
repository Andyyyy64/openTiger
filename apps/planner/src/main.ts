import { stat, mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { db, closeDb } from "@h1ve/db";
import { tasks, agents, events } from "@h1ve/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import dotenv from "dotenv";
import { getRepoMode, getLocalRepoPath } from "@h1ve/core";

// ハートビートの間隔（ミリ秒）
const HEARTBEAT_INTERVAL = 30000; // 30秒

// ハートビートを送信する関数
function startHeartbeat(agentId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

import {
  parseRequirementFile,
  parseRequirementContent,
  validateRequirement,
  type Requirement,
} from "./parser.js";
import {
  generateTasksFromRequirement,
  generateSimpleTasks,
  type PlannedTaskInput,
  type TaskGenerationResult,
} from "./strategies/index.js";
import { inspectCodebase, formatInspectionNotes } from "./inspection.js";

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

  console.log(`[Logger] Planner logs are written to ${logPath}`);
  return logPath;
}

// Plannerの設定
interface PlannerConfig {
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  dryRun: boolean;
  timeoutSeconds: number;
  inspectCodebase: boolean;
  inspectionTimeoutSeconds: number;
  repoUrl?: string;
  baseBranch: string;
}

const envPath = process.env.DOTENV_CONFIG_PATH
  ?? resolve(import.meta.dirname, "../../../.env");
dotenv.config({ path: envPath });

function resolvePlannerWorkdir(): string {
  const repoMode = getRepoMode();
  const localRepoPath = getLocalRepoPath();
  // local modeでは実リポジトリを点検対象にする
  if (repoMode === "local" && localRepoPath) {
    return localRepoPath;
  }
  return process.cwd();
}

// デフォルト設定
const DEFAULT_CONFIG: PlannerConfig = {
  workdir: resolvePlannerWorkdir(),
  instructionsPath: resolve(
    import.meta.dirname,
    "../instructions/planning.md"
  ),
  useLlm: process.env.USE_LLM !== "false",
  dryRun: process.env.DRY_RUN === "true",
  timeoutSeconds: parseInt(process.env.PLANNER_TIMEOUT ?? "300", 10),
  inspectCodebase: process.env.PLANNER_INSPECT !== "false",
  inspectionTimeoutSeconds: parseInt(process.env.PLANNER_INSPECT_TIMEOUT ?? "180", 10),
  repoUrl: process.env.PLANNER_REPO_URL
    ?? (process.env.PLANNER_USE_REMOTE === "true" ? process.env.REPO_URL : undefined),
  baseBranch: process.env.BASE_BRANCH ?? "main",
};

const INIT_ALLOWED_PATHS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  "apps/**",
  "packages/**",
];

const INIT_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
];
const LOCKFILE_PATHS = ["pnpm-lock.yaml"];

function mergeAllowedPaths(current: string[], extra: string[]): string[] {
  const seen = new Set(current);
  const merged = [...current];

  for (const path of extra) {
    if (!seen.has(path)) {
      merged.push(path);
      seen.add(path);
    }
  }

  return merged;
}

function isInitializationTask(task: PlannedTaskInput): boolean {
  const title = task.title.toLowerCase();
  const hintMatches =
    ["init", "initialize", "bootstrap", "setup", "scaffold", "monorepo", "workspace"]
      .some((hint) => title.includes(hint))
    || ["初期化", "セットアップ", "構成", "モノレポ", "ワークスペース", "基盤"]
      .some((hint) => task.title.includes(hint));

  if (hintMatches) {
    return true;
  }

  const files = task.context?.files ?? [];
  return files.some((file) => INIT_ROOT_FILES.includes(file));
}

function normalizeVerificationCommands(commands: string[]): string[] {
  return commands.map((command) => {
    return command;
  });
}

function normalizeGeneratedTasks(result: TaskGenerationResult): TaskGenerationResult {
  const tasks = result.tasks.map((task) => {
    let normalized: PlannedTaskInput = { ...task };
    const normalizedCommands = normalizeVerificationCommands(task.commands);

    if (normalizedCommands !== task.commands) {
      normalized = { ...normalized, commands: normalizedCommands };
    }

    if (isInitializationTask(task)) {
      normalized = {
        ...normalized,
        allowedPaths: mergeAllowedPaths(task.allowedPaths, INIT_ALLOWED_PATHS),
      };
    }

    if (requiresLockfile(task.commands)) {
      // install に付随する lockfile の変更を許可する
      normalized = {
        ...normalized,
        allowedPaths: mergeAllowedPaths(task.allowedPaths, LOCKFILE_PATHS),
      };
    }

    return normalized;
  });

  return { ...result, tasks };
}

// テスト関連の手がかりから担当ロールを推定する
function inferTaskRole(task: PlannedTaskInput): "worker" | "tester" {
  const hintText = [
    task.title,
    task.goal,
    task.context?.specs,
    task.context?.notes,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const testerPatterns = [
    /\be2e\b/,
    /\bplaywright\b/,
    /\bvitest\b/,
    /\bcypress\b/,
    /\btest(s)?\s*(add|create|write|implement|update|fix)\b/,
    /テスト(追加|作成|実装|更新|修正|強化)/,
    /フレーク|flaky/,
  ];
  if (testerPatterns.some((pattern) => pattern.test(hintText))) {
    return "tester";
  }

  const pathHints = [
    ...(task.allowedPaths ?? []),
    ...(task.context?.files ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (/(test|__tests__|spec|playwright|e2e)/.test(pathHints)) {
    return "tester";
  }

  return "worker";
}

function applyTaskRolePolicy(result: TaskGenerationResult): TaskGenerationResult {
  const tasks = result.tasks.map((task) => {
    if (task.role) {
      return task;
    }
    return { ...task, role: inferTaskRole(task) };
  });
  return { ...result, tasks };
}

function isCheckCommand(command: string): boolean {
  return /\b(pnpm|npm)\b[^\n]*\b(run\s+)?check\b/.test(command);
}

function isDevCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?dev\b/.test(command);
}

function ensureDevCommand(commands: string[], devCommand?: string): string[] {
  if (!devCommand) {
    return commands;
  }
  if (commands.some((command) => isDevCommand(command))) {
    return commands;
  }
  return [...commands, devCommand];
}

function applyDevCommandPolicy(
  result: TaskGenerationResult,
  devCommand?: string
): TaskGenerationResult {
  if (!devCommand) {
    return result;
  }
  const tasks = result.tasks.map((task) => {
    const updatedCommands = ensureDevCommand(task.commands, devCommand);
    if (updatedCommands === task.commands) {
      return task;
    }
    return { ...task, commands: updatedCommands };
  });
  return { ...result, tasks };
}

function filterVerificationCommands(
  commands: string[],
  checkScriptAvailable: boolean
): string[] {
  if (checkScriptAvailable) {
    return commands;
  }

  return commands.filter((command) => !isCheckCommand(command));
}

function applyVerificationCommandPolicy(
  result: TaskGenerationResult,
  checkScriptAvailable: boolean
): TaskGenerationResult {
  // checkスクリプトの有無に合わせて検証コマンドを揃える
  if (checkScriptAvailable) {
    return result;
  }

  const tasks = result.tasks.map((task) => {
    const filtered = filterVerificationCommands(task.commands, checkScriptAvailable);
    if (filtered.length === task.commands.length) {
      return task;
    }
    return { ...task, commands: filtered };
  });

  return { ...result, tasks };
}

async function hasRootCheckScript(workdir: string): Promise<boolean> {
  // ルートのpackage.jsonにcheckスクリプトがあるか確認する
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.check === "string";
  } catch {
    return false;
  }
}

function taskTouchesFrontend(task: PlannedTaskInput): boolean {
  const text = [
    task.title,
    task.goal,
    task.context?.specs,
    task.context?.notes,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const textHints = ["frontend", "フロント", "ui", "画面", "web"];
  if (textHints.some((hint) => text.includes(hint))) {
    return true;
  }
  const paths = [
    ...(task.allowedPaths ?? []),
    ...(task.context?.files ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return /apps\/web|web\/|frontend|ui/.test(paths);
}

function hasE2ECommand(commands: string[]): boolean {
  return commands.some((command) => /\b(e2e|playwright)\b/i.test(command));
}

// フロントタスクのtesterにE2E検証を補う
function applyTesterCommandPolicy(
  result: TaskGenerationResult,
  e2eCommand?: string
): TaskGenerationResult {
  if (!e2eCommand) {
    return result;
  }
  const tasks = result.tasks.map((task) => {
    if (task.role !== "tester") {
      return task;
    }
    if (!taskTouchesFrontend(task) || hasE2ECommand(task.commands)) {
      return task;
    }
    return {
      ...task,
      commands: [...task.commands, e2eCommand],
    };
  });
  return { ...result, tasks };
}

async function hasRootDevScript(workdir: string): Promise<boolean> {
  // ルートのpackage.jsonにdevスクリプトがあるか確認する
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.dev === "string";
  } catch {
    return false;
  }
}

async function resolveDevVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  if (!(await hasRootDevScript(workdir))) {
    return undefined;
  }
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run dev";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn dev";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run dev";
  }
  return "npm run dev";
}

async function resolveE2EVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run e2e";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn e2e";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run e2e";
  }
  return "npm run e2e";
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeStringList(items: unknown, maxItems: number): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => clipText(item, 200));
}

function extractIssueMessages(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages = value
    .map((item) => {
      if (typeof item === "object" && item !== null && "message" in item) {
        const message = (item as { message?: unknown }).message;
        if (typeof message === "string") {
          return message;
        }
      }
      return undefined;
    })
    .filter((item): item is string => typeof item === "string");

  return messages.slice(0, maxItems).map((item) => clipText(item, 200));
}

function formatJudgeFeedbackEntry(payload: Record<string, unknown>): string | undefined {
  const rawPrNumber = payload.prNumber;
  const prNumber = typeof rawPrNumber === "number"
    ? rawPrNumber
    : typeof rawPrNumber === "string" && !Number.isNaN(Number(rawPrNumber))
      ? Number(rawPrNumber)
      : undefined;
  const verdict = typeof payload.verdict === "string" ? payload.verdict : "unknown";
  const reasons = normalizeStringList(payload.reasons, 3);
  const suggestions = normalizeStringList(payload.suggestions, 3);
  const summary = payload.summary;
  const codeIssues =
    typeof summary === "object"
    && summary !== null
    && "llm" in summary
    && typeof (summary as { llm?: unknown }).llm === "object"
    ? extractIssueMessages(
      (summary as { llm?: { codeIssues?: unknown } }).llm?.codeIssues,
      3
    )
    : [];

  const details: string[] = [];

  if (reasons.length > 0) {
    details.push(`理由: ${reasons.join(" / ")}`);
  }

  if (suggestions.length > 0) {
    details.push(`改善案: ${suggestions.join(" / ")}`);
  }

  if (codeIssues.length > 0) {
    details.push(`指摘: ${codeIssues.join(" / ")}`);
  }

  const label = prNumber ? `PR #${prNumber}` : "PR";
  if (details.length === 0) {
    return `${label} (${verdict})`;
  }

  return `${label} (${verdict}) ${details.join(" | ")}`;
}

async function loadJudgeFeedback(limit: number = 5): Promise<string | undefined> {
  // Judgeのレビュー結果を直近分だけ取得する
  const rows = await db
    .select({
      payload: events.payload,
    })
    .from(events)
    .where(eq(events.type, "judge.review"))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  const lines = rows
    .map((row) => {
      const payload = row.payload;
      if (typeof payload !== "object" || payload === null) {
        return undefined;
      }
      return formatJudgeFeedbackEntry(payload as Record<string, unknown>);
    })
    .filter((line): line is string => typeof line === "string");

  if (lines.length === 0) {
    return;
  }

  return lines.map((line) => `- ${line}`).join("\n");
}

function attachJudgeFeedbackToRequirement(
  requirement: Requirement,
  feedback: string | undefined
): Requirement {
  // 要件のノートにJudgeの結果を補足する
  if (!feedback) {
    return requirement;
  }

  const feedbackBlock = `Judgeフィードバック:\n${feedback}`;
  const notes = requirement.notes
    ? `${requirement.notes}\n\n${feedbackBlock}`
    : feedbackBlock;

  return { ...requirement, notes };
}

function attachJudgeFeedbackToTasks(
  result: TaskGenerationResult,
  feedback: string | undefined
): TaskGenerationResult {
  // Workerに引き継ぐためタスクのノートへ反映する
  if (!feedback) {
    return result;
  }

  const feedbackBlock = `Judgeフィードバック:\n${feedback}`;
  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes
      ? `${context.notes}\n\n${feedbackBlock}`
      : feedbackBlock;

    return {
      ...task,
      context: {
        ...context,
        notes,
      },
    };
  });

  return { ...result, tasks };
}

function attachInspectionToRequirement(
  requirement: Requirement,
  inspectionNotes: string | undefined
): Requirement {
  // 差分点検の内容を要件に残してタスク生成へ引き継ぐ
  if (!inspectionNotes) {
    return requirement;
  }

  const notes = requirement.notes
    ? `${requirement.notes}\n\n${inspectionNotes}`
    : inspectionNotes;

  return { ...requirement, notes };
}

async function loadExistingTaskHints(limit: number = 30): Promise<string | undefined> {
  try {
    const rows = await db
      .select({
        title: tasks.title,
        goal: tasks.goal,
        status: tasks.status,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running", "blocked"]))
      .orderBy(desc(tasks.createdAt))
      .limit(limit);

    if (rows.length === 0) {
      return;
    }

    const lines = rows.map((row) => {
      const title = clipText(row.title, 120);
      const goal = clipText(row.goal, 120);
      return `- ${title} (${row.status}) : ${goal}`;
    });

    return lines.join("\n");
  } catch (error) {
    console.warn("[Planner] Failed to load existing tasks:", error);
    return;
  }
}

function attachExistingTasksToRequirement(
  requirement: Requirement,
  hints: string | undefined
): Requirement {
  // 既存タスクを共有して重複した計画の生成を抑える
  if (!hints) {
    return requirement;
  }

  const block = `既存タスク（重複回避の参考）:\n${hints}`;
  const notes = requirement.notes ? `${requirement.notes}\n\n${block}` : block;
  return { ...requirement, notes };
}

function attachInspectionToTasks(
  result: TaskGenerationResult,
  inspectionNotes: string | undefined
): TaskGenerationResult {
  // 差分点検の内容をWorkerにも共有して探索を深める
  if (!inspectionNotes) {
    return result;
  }

  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes
      ? `${context.notes}\n\n${inspectionNotes}`
      : inspectionNotes;

    return {
      ...task,
      context: {
        ...context,
        notes,
      },
    };
  });

  return { ...result, tasks };
}

function requiresLockfile(commands: string[]): boolean {
  return commands.some((command) => {
    const trimmed = command.trim();
    return /\bpnpm\b[^\n]*\b(install|add|i)\b/.test(trimmed);
  });
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isRepoUninitialized(workdir: string): Promise<boolean> {
  const hasApps = await pathIsDirectory(join(workdir, "apps"));
  const hasPackages = await pathIsDirectory(join(workdir, "packages"));

  if (hasApps || hasPackages) {
    return false;
  }

  const hasRootPackage = await pathIsFile(join(workdir, "package.json"));
  const hasWorkspace = await pathIsFile(join(workdir, "pnpm-workspace.yaml"));

  return !hasRootPackage && !hasWorkspace;
}

function generateInitializationTasks(requirement: Requirement): TaskGenerationResult {
  const allowedPaths = mergeAllowedPaths(requirement.allowedPaths, INIT_ALLOWED_PATHS);
  const task: PlannedTaskInput = {
    title: "モノレポ構成の初期化",
    goal: "pnpm workspaces が使える状態になり、pnpm -r list が成功する",
    role: "worker",
    context: {
      files: [
        "package.json",
        "pnpm-workspace.yaml",
        ".gitignore",
        "apps/",
        "packages/",
      ],
      specs: "apps/ と packages/ の土台と最小限のpackage.jsonを用意する",
      notes: requirement.goal,
    },
    allowedPaths,
    commands: ["pnpm install", "pnpm -r list"],
    priority: 100,
    riskLevel: "low",
    dependencies: [],
    dependsOnIndexes: [],
    timeboxMinutes: 45,
    targetArea: undefined,
    touches: [],
  };

  return {
    tasks: [task],
    warnings: [
      "モノレポ構成が見つからないため初期化タスクのみ生成しました。初期化完了後にPlannerを再実行してください。",
    ],
    totalEstimatedMinutes: task.timeboxMinutes ?? 45,
  };
}

// タスクをDBに保存
async function saveTasks(taskInputs: PlannedTaskInput[]): Promise<string[]> {
  const savedIds: string[] = [];

  for (const input of taskInputs) {
    const result = await db
      .insert(tasks)
      .values({
        title: input.title,
        goal: input.goal,
        context: input.context,
        allowedPaths: input.allowedPaths,
        commands: input.commands,
        priority: input.priority ?? 0,
        riskLevel: input.riskLevel ?? "low",
        dependencies: input.dependencies ?? [],
        timeboxMinutes: input.timeboxMinutes ?? 60,
      })
      .returning({ id: tasks.id });

    const saved = result[0];
    if (saved) {
      savedIds.push(saved.id);
    }
  }

  return savedIds;
}

// 依存関係を解決してDBのIDで更新
async function resolveDependencies(
  savedIds: string[],
  originalTasks: PlannedTaskInput[]
): Promise<void> {
  // 元のタスクにdependsOnがあった場合、インデックスからIDに変換
  for (let i = 0; i < originalTasks.length; i++) {
    const original = originalTasks[i];
    const savedId = savedIds[i];

    if (!original || !savedId) continue;

    const dependsOnIndexes = original.dependsOnIndexes ?? [];
    if (dependsOnIndexes.length === 0) continue;

    const dependencyIds = dependsOnIndexes
      .map((depIndex) => savedIds[depIndex])
      .filter((depId): depId is string => typeof depId === "string");

    if (dependencyIds.length === 0) {
      console.warn(`[Planner] dependencies resolve failed for task ${savedId}`);
      continue;
    }

    if (dependencyIds.length !== dependsOnIndexes.length) {
      console.warn(
        `[Planner] dependencies mismatch for task ${savedId} (indexes: ${dependsOnIndexes.join(", ")})`
      );
    }

    await db
      .update(tasks)
      .set({ dependencies: dependencyIds, updatedAt: new Date() })
      .where(eq(tasks.id, savedId));
  }
}

async function recordPlannerPlanEvent(params: {
  requirementPath: string;
  requirement: Requirement;
  result: TaskGenerationResult;
  savedIds: string[];
  agentId: string;
}): Promise<void> {
  const { requirementPath, requirement, result, savedIds, agentId } = params;
  const taskSummaries = result.tasks
    .map((task, index) => {
      const id = savedIds[index];
      if (!id) {
        return undefined;
      }
      return {
        id,
        title: task.title,
        goal: task.goal,
        role: task.role ?? "worker",
        riskLevel: task.riskLevel ?? "low",
        priority: task.priority ?? 0,
        dependencies: task.dependencies ?? [],
      };
    })
    .filter(
      (task): task is NonNullable<typeof task> => typeof task !== "undefined"
    );

  try {
    await db.insert(events).values({
      type: "planner.plan_created",
      entityType: "system",
      entityId: "00000000-0000-0000-0000-000000000000",
      agentId,
      payload: {
        requirementPath,
        requirement: {
          goal: requirement.goal,
          acceptanceCriteriaCount: requirement.acceptanceCriteria.length,
          allowedPaths: requirement.allowedPaths,
          notes: requirement.notes,
        },
        summary: {
          totalTasks: result.tasks.length,
          totalEstimatedMinutes: result.totalEstimatedMinutes,
          warnings: result.warnings,
        },
        taskIds: taskSummaries.map((task) => task.id),
        tasks: taskSummaries,
      },
    });
  } catch (error) {
    console.warn("[Planner] Failed to record plan event:", error);
  }
}

// 要件ファイルからタスクを生成
async function planFromRequirement(
  requirementPath: string,
  config: PlannerConfig,
  agentId: string
): Promise<void> {
  console.log("=".repeat(60));
  console.log("h1ve Planner - Task Generation");
  console.log("=".repeat(60));
  console.log(`Requirement file: ${requirementPath}`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log("=".repeat(60));

  // 要件ファイルを読み込み
  let requirement: Requirement;
  try {
    requirement = await parseRequirementFile(requirementPath);
  } catch (error) {
    console.error(`Failed to read requirement file: ${error}`);
    process.exit(1);
  }

  // 要件を検証
  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    console.error("Validation errors:");
    for (const error of validationErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("\n[Parsed Requirement]");
  console.log(`Goal: ${requirement.goal}`);
  console.log(`Acceptance Criteria: ${requirement.acceptanceCriteria.length} items`);
  console.log(`Allowed Paths: ${requirement.allowedPaths.join(", ")}`);

  const judgeFeedback = await loadJudgeFeedback();
  if (judgeFeedback) {
    console.log("\n[Planner] Loaded judge feedback for context.");
    requirement = attachJudgeFeedbackToRequirement(requirement, judgeFeedback);
  }
  const existingTaskHints = await loadExistingTaskHints();
  requirement = attachExistingTasksToRequirement(requirement, existingTaskHints);
  const checkScriptAvailable = await hasRootCheckScript(config.workdir);
  if (!checkScriptAvailable) {
    console.log("[Planner] checkスクリプトがないため検証コマンドを調整します。");
  }
  const devCommand = await resolveDevVerificationCommand(config.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(config.workdir);
  const repoUninitialized = await isRepoUninitialized(config.workdir);
  let inspectionNotes: string | undefined;
  if (config.useLlm && config.inspectCodebase && !repoUninitialized) {
    console.log("\n[Planner] Inspecting codebase with LLM...");
    const inspection = await inspectCodebase(requirement, {
      workdir: config.workdir,
      timeoutSeconds: config.inspectionTimeoutSeconds,
    });
    if (inspection) {
      inspectionNotes = formatInspectionNotes(inspection);
      requirement = attachInspectionToRequirement(requirement, inspectionNotes);
    }
  }

  // タスクを生成
  let result: TaskGenerationResult;

  if (repoUninitialized) {
    console.log("\n[Planner] Repository is not initialized. Generating init task only.");
    result = generateInitializationTasks(requirement);
  } else if (config.useLlm) {
    console.log("\n[Generating tasks with LLM...]");
    try {
      result = await generateTasksFromRequirement(requirement, {
        workdir: config.workdir,
        instructionsPath: config.instructionsPath,
        timeoutSeconds: config.timeoutSeconds,
      });
    } catch (error) {
      console.warn(`LLM generation failed: ${error}`);
      console.log("Falling back to simple generation...");
      result = generateSimpleTasks(requirement);
    }
  } else {
    console.log("\n[Generating tasks without LLM...]");
    result = generateSimpleTasks(requirement);
  }

  result = normalizeGeneratedTasks(result);
  result = applyTaskRolePolicy(result);
  result = applyVerificationCommandPolicy(result, checkScriptAvailable);
  result = applyTesterCommandPolicy(result, e2eCommand);
  result = applyDevCommandPolicy(result, devCommand);
  result = attachJudgeFeedbackToTasks(result, judgeFeedback);
  result = attachInspectionToTasks(result, inspectionNotes);

  // 結果を表示
  console.log(`\n[Generated ${result.tasks.length} tasks]`);
  console.log(`Total estimated time: ${result.totalEstimatedMinutes} minutes`);

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  console.log("\nTasks:");
  for (let i = 0; i < result.tasks.length; i++) {
    const task = result.tasks[i];
    if (!task) continue;
    console.log(`  ${i + 1}. ${task.title}`);
    console.log(`     Goal: ${task.goal.slice(0, 80)}${task.goal.length > 80 ? "..." : ""}`);
    console.log(`     Priority: ${task.priority}, Risk: ${task.riskLevel}, Time: ${task.timeboxMinutes}min`);
  }

  // Dry runの場合は保存しない
  if (config.dryRun) {
    console.log("\n[Dry run mode - tasks not saved]");
    return;
  }

  // DBに保存
  console.log("\n[Saving tasks to database...]");
  const savedIds = await saveTasks(result.tasks);
  await resolveDependencies(savedIds, result.tasks);

  // Plannerの計画内容をUI側で参照できるように記録する
  await recordPlannerPlanEvent({
    requirementPath,
    requirement,
    result,
    savedIds,
    agentId,
  });

  console.log(`\nSaved ${savedIds.length} tasks to database`);
  console.log("Task IDs:");
  for (const id of savedIds) {
    console.log(`  - ${id}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Planning complete!");
  console.log("=".repeat(60));
}

// Plannerが参照する作業ディレクトリを用意
async function preparePlannerWorkdir(config: PlannerConfig): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  if (!config.repoUrl) {
    console.log(`[Planner] Using local workdir: ${config.workdir}`);
    return {
      workdir: config.workdir,
      cleanup: async () => undefined,
    };
  }

  console.log(`[Planner] Using remote repo: ${config.repoUrl}`);
  const tempDir = await mkdtemp(join(tmpdir(), "h1ve-planner-"));
  const repoDir = join(tempDir, "repo");
  const token = process.env.GITHUB_TOKEN;
  const cloneResult = await gitCloneRepo(config.repoUrl, repoDir, token, config.baseBranch);

  if (!cloneResult.success) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Planner failed to clone repo: ${cloneResult.stderr}`);
  }

  return {
    workdir: repoDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function gitCloneRepo(
  repoUrl: string,
  destPath: string,
  token?: string,
  baseBranch?: string
): Promise<{ success: boolean; stderr: string }> {
  let authenticatedUrl = repoUrl;
  if (token && repoUrl.startsWith("https://github.com/")) {
    authenticatedUrl = repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${token}@github.com/`
    );
  }

  const runClone = (args: string[]) =>
    new Promise<{ success: boolean; stderr: string }>((resolveResult) => {
      const child = spawn("git", args, {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // 認証待ちで止めない
        },
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        resolveResult({
          success: code === 0,
          stderr: stderr.trim(),
        });
      });

      child.on("error", (error) => {
        resolveResult({
          success: false,
          stderr: error.message,
        });
      });
    });

  const args = ["clone", "--depth", "1"];
  if (baseBranch) {
    args.push("--branch", baseBranch);
  }
  args.push(authenticatedUrl, destPath);

  const result = await runClone(args);
  if (result.success || !baseBranch) {
    return result;
  }

  console.warn(
    `[Planner] Failed to clone branch ${baseBranch}, retrying default branch`
  );

  return runClone(["clone", "--depth", "1", authenticatedUrl, destPath]);
}

// 要件テキストから直接タスクを生成（API用）
export async function planFromContent(
  content: string,
  config: Partial<PlannerConfig> = {}
): Promise<TaskGenerationResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  let requirement = parseRequirementContent(content);

  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(", ")}`);
  }

  const judgeFeedback = await loadJudgeFeedback();
  requirement = attachJudgeFeedbackToRequirement(requirement, judgeFeedback);
  const existingTaskHints = await loadExistingTaskHints();
  requirement = attachExistingTasksToRequirement(requirement, existingTaskHints);
  const checkScriptAvailable = await hasRootCheckScript(fullConfig.workdir);
  const devCommand = await resolveDevVerificationCommand(fullConfig.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(fullConfig.workdir);
  const repoUninitialized = await isRepoUninitialized(fullConfig.workdir);
  let inspectionNotes: string | undefined;
  if (fullConfig.useLlm && fullConfig.inspectCodebase && !repoUninitialized) {
    const inspection = await inspectCodebase(requirement, {
      workdir: fullConfig.workdir,
      timeoutSeconds: fullConfig.inspectionTimeoutSeconds,
    });
    if (inspection) {
      inspectionNotes = formatInspectionNotes(inspection);
      requirement = attachInspectionToRequirement(requirement, inspectionNotes);
    }
  }

  if (repoUninitialized) {
    return attachInspectionToTasks(
      attachJudgeFeedbackToTasks(
        applyDevCommandPolicy(
          applyTesterCommandPolicy(
            applyVerificationCommandPolicy(
              applyTaskRolePolicy(
                normalizeGeneratedTasks(generateInitializationTasks(requirement))
              ),
              checkScriptAvailable
            ),
            e2eCommand
          ),
          devCommand
        ),
        judgeFeedback
      ),
      inspectionNotes
    );
  }

  if (fullConfig.useLlm) {
    try {
      const result = await generateTasksFromRequirement(requirement, {
        workdir: fullConfig.workdir,
        instructionsPath: fullConfig.instructionsPath,
        timeoutSeconds: fullConfig.timeoutSeconds,
      });
      return attachInspectionToTasks(
        attachJudgeFeedbackToTasks(
          applyDevCommandPolicy(
            applyTesterCommandPolicy(
              applyVerificationCommandPolicy(
                applyTaskRolePolicy(normalizeGeneratedTasks(result)),
                checkScriptAvailable
              ),
              e2eCommand
            ),
            devCommand
          ),
          judgeFeedback
        ),
        inspectionNotes
      );
    } catch {
      return attachInspectionToTasks(
        attachJudgeFeedbackToTasks(
          applyDevCommandPolicy(
            applyTesterCommandPolicy(
              applyVerificationCommandPolicy(
                applyTaskRolePolicy(
                  normalizeGeneratedTasks(generateSimpleTasks(requirement))
                ),
                checkScriptAvailable
              ),
              e2eCommand
            ),
            devCommand
          ),
          judgeFeedback
        ),
        inspectionNotes
      );
    }
  }

  return attachInspectionToTasks(
    attachJudgeFeedbackToTasks(
      applyDevCommandPolicy(
        applyTesterCommandPolicy(
          applyVerificationCommandPolicy(
            applyTaskRolePolicy(normalizeGeneratedTasks(generateSimpleTasks(requirement))),
            checkScriptAvailable
          ),
          e2eCommand
        ),
        devCommand
      ),
      judgeFeedback
    ),
    inspectionNotes
  );
}

// ヘルプを表示
function showHelp(): void {
  console.log(`
h1ve Planner - Generate tasks from requirements

Usage:
  pnpm --filter @h1ve/planner start <requirement.md>
  pnpm --filter @h1ve/planner start --help

Options:
  --help          Show this help message
  --dry-run       Generate tasks but don't save to database
  --no-llm        Skip LLM and use simple generation

Environment Variables:
  USE_LLM=false         Disable LLM generation
  DRY_RUN=true          Enable dry run mode
  PLANNER_TIMEOUT=300   LLM timeout in seconds
  PLANNER_MODEL=xxx     Planner LLM model
  PLANNER_INSPECT=false Skip codebase inspection
  PLANNER_INSPECT_TIMEOUT=180  LLM inspection timeout in seconds

Example:
  pnpm --filter @h1ve/planner start docs/requirements/feature-x.md
`);
}

// メイン処理
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ヘルプ
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // 設定を構築
  const config = { ...DEFAULT_CONFIG };

  if (args.includes("--dry-run")) {
    config.dryRun = true;
  }

  if (args.includes("--no-llm")) {
    config.useLlm = false;
  }

  // エージェント登録
  const agentId = process.env.AGENT_ID ?? "planner-1";
  setupProcessLogging(agentId);
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";
  await db.delete(agents).where(eq(agents.id, agentId));

  await db.insert(agents).values({
    id: agentId,
    role: "planner",
    status: "idle",
    lastHeartbeat: new Date(),
    metadata: {
      model: plannerModel, // Plannerは高精度モデルで計画品質を優先する
      provider: "gemini",
    },
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      status: "idle",
      lastHeartbeat: new Date(),
    },
  });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);

  // 引数がない場合は環境変数の要件パスを利用する
  const requirementPath = args.find((arg) => !arg.startsWith("--"))
    ?? process.env.REQUIREMENT_PATH
    ?? process.env.REPLAN_REQUIREMENT_PATH;

  if (!requirementPath) {
    console.error("Error: Requirement file path is required");
    showHelp();
    process.exit(1);
  }

  // ファイルの存在確認
  try {
    await stat(requirementPath);
  } catch {
    console.error(`Error: File not found: ${requirementPath}`);
    process.exit(1);
  }

  // 実行中はbusyに切り替える
  await db
    .update(agents)
    .set({ status: "busy", lastHeartbeat: new Date() })
    .where(eq(agents.id, agentId));

  try {
    const { workdir, cleanup } = await preparePlannerWorkdir(config);
    try {
      await planFromRequirement(resolve(requirementPath), { ...config, workdir }, agentId);
    } finally {
      await cleanup();
    }
  } finally {
    await db
      .update(agents)
      .set({ status: "idle", lastHeartbeat: new Date() })
      .where(eq(agents.id, agentId));
    clearInterval(heartbeatTimer);
    // 単発実行の終了でDB接続を閉じる
    await closeDb();
  }
}

main().catch((error) => {
  console.error("Planner crashed:", error);
  process.exit(1);
});
