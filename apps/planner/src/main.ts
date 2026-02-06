import { stat, mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { db, closeDb } from "@sebastian-code/db";
import { tasks, agents, events } from "@sebastian-code/db/schema";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import dotenv from "dotenv";
import { getRepoMode, getLocalRepoPath } from "@sebastian-code/core";
import { createIssue } from "@sebastian-code/vcs";

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
import type { CodebaseInspection } from "./inspection.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.SEBASTIAN_LOG_DIR ?? "/tmp/sebastian-code-logs";

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolvePlannerWorkdir(): string {
  const repoMode = getRepoMode();
  const localRepoPath = getLocalRepoPath();
  // local modeでは実リポジトリを点検対象にする
  if (repoMode === "local" && localRepoPath) {
    return localRepoPath;
  }
  // 起動ディレクトリがapps配下でもリポジトリルートを参照する
  const gitRoot = resolveGitRoot(process.cwd());
  return gitRoot ?? process.cwd();
}

function resolveGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf-8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? root : undefined;
}

// デフォルト設定
const DEFAULT_CONFIG: PlannerConfig = {
  workdir: resolvePlannerWorkdir(),
  instructionsPath: resolve(
    import.meta.dirname,
    "../instructions/planning.md"
  ),
  useLlm: parseBoolean(process.env.USE_LLM, true),
  dryRun: parseBoolean(process.env.DRY_RUN, false),
  timeoutSeconds: parseInt(process.env.PLANNER_TIMEOUT ?? "300", 10),
  inspectCodebase: parseBoolean(process.env.PLANNER_INSPECT, true),
  inspectionTimeoutSeconds: parseInt(process.env.PLANNER_INSPECT_TIMEOUT ?? "180", 10),
  repoUrl: (() => {
    const plannerRepoUrl = process.env.PLANNER_REPO_URL?.trim();
    if (plannerRepoUrl) {
      return plannerRepoUrl;
    }
    const useRemote = parseBoolean(process.env.PLANNER_USE_REMOTE, false);
    return useRemote ? process.env.REPO_URL : undefined;
  })(),
  baseBranch: process.env.BASE_BRANCH ?? "main",
};

// 初期化タスクで変更を許可するルート設定ファイル
const INIT_ALLOWED_PATHS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  "tsconfig.json",
  "tsconfig.*.json",
  ".eslintrc.*",
  ".prettierrc*",
  "biome.json",
  "turbo.json",
  "docker-compose.yml",
  "Dockerfile",
  ".env.example",
  "README.md",
  "apps/**",
  "packages/**",
];

const INIT_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  "tsconfig.json",
];
const LOCKFILE_PATHS = ["pnpm-lock.yaml"];
// docser はドキュメント整備が主務だが、package.json の scripts 補完や
// .env.example の追記など軽微なルート変更が必要になるケースを許容する
const DOCSER_ALLOWED_PATHS = [
  "docs/**",
  "ops/**",
  "README.md",
  "package.json",
  ".env.example",
];

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
  const files = task.context?.files ?? [];
  if (files.some((file) => INIT_ROOT_FILES.includes(file))) {
    return true;
  }

  const allowed = task.allowedPaths ?? [];
  const rootEvidence = [...allowed, ...files].some((path) =>
    INIT_ROOT_FILES.includes(path)
    || path === "apps/"
    || path === "packages/"
    || path === "apps/**"
    || path === "packages/**"
  );

  if (!rootEvidence) {
    return false;
  }

  const title = task.title.toLowerCase();
  return ["init", "initialize", "bootstrap", "setup", "scaffold", "monorepo", "workspace"]
    .some((hint) => title.includes(hint))
    || ["初期化", "セットアップ", "モノレポ", "ワークスペース"]
      .some((hint) => task.title.includes(hint));
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

    // AIが依存追加を行う可能性があるため、全タスクで lockfile の変更を許可する
    normalized = {
      ...normalized,
      allowedPaths: mergeAllowedPaths(normalized.allowedPaths, LOCKFILE_PATHS),
    };

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
  // `dev` は常駐プロセスになりやすく検証用途には不向きなので自動補完しない
  return commands;
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
  return commands.filter((command) => {
    if (isDevCommand(command)) {
      return false;
    }
    if (!checkScriptAvailable && isCheckCommand(command)) {
      return false;
    }
    return true;
  });
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

async function resolveCheckVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  if (!(await hasRootCheckScript(workdir))) {
    return undefined;
  }
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run check";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn check";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run check";
  }
  return "npm run check";
}

async function computeRequirementHash(
  requirementPath: string
): Promise<string | undefined> {
  try {
    const content = await readFile(requirementPath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    console.warn("[Planner] Failed to read requirement file:", error);
    return;
  }
}

async function resolveRepoHeadSha(workdir: string): Promise<string | undefined> {
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
        console.warn("[Planner] git rev-parse failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }

      const sha = stdout.trim().split(/\s+/)[0];
      resolveResult(sha || undefined);
    });

    child.on("error", (error) => {
      console.warn("[Planner] git rev-parse error:", error);
      resolveResult(undefined);
    });
  });
}

async function computePlanSignature(params: {
  requirementPath: string;
  workdir: string;
  repoUrl?: string;
  baseBranch: string;
}): Promise<{ signature: string; requirementHash: string; repoHeadSha: string } | undefined> {
  const requirementHash = await computeRequirementHash(params.requirementPath);
  if (!requirementHash) {
    return;
  }

  const repoHeadSha = await resolveRepoHeadSha(params.workdir);
  if (!repoHeadSha) {
    console.warn("[Planner] Failed to resolve repo HEAD for signature.");
    return;
  }

  const repoIdentity = params.repoUrl
    ? params.repoUrl
    : `local:${resolve(params.workdir)}`;
  const signaturePayload = {
    requirementHash,
    repoHeadSha,
    repoUrl: repoIdentity,
    baseBranch: params.baseBranch,
  };
  const signature = createHash("sha256")
    .update(JSON.stringify(signaturePayload))
    .digest("hex");

  return { signature, requirementHash, repoHeadSha };
}

const DEFAULT_PLAN_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10分

function resolvePlanDedupeWindowMs(): number {
  const raw = process.env.PLANNER_DEDUPE_WINDOW_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PLAN_DEDUPE_WINDOW_MS;
}

async function wasPlanRecentlyCreated(signature: string, windowMs: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(
      eq(events.type, "planner.plan_created"),
      sql`${events.payload} ->> 'signature' = ${signature}`,
      sql`${events.createdAt} >= ${since}`
    ))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return Boolean(row?.id);
}

async function tryAcquirePlanSaveLock(signature: string): Promise<boolean> {
  // 同一署名の保存を単一プロセスに限定して、二重起動時の競合と重複保存を防ぐ
  const result = await db.execute(
    sql`SELECT pg_try_advisory_lock(hashtext(${signature})) AS locked`
  );
  const row = (result as { rows?: Array<{ locked?: boolean | null }> }).rows?.[0];
  return row?.locked === true;
}

async function releasePlanSaveLock(signature: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${signature}))`);
}

type DocGapInfo = {
  docsMissing: boolean;
  docsEmpty: boolean;
  readmeMissing: boolean;
  docsReadmeMissing: boolean;
  hasGap: boolean;
};

async function detectDocGap(workdir: string): Promise<DocGapInfo> {
  const docsPath = join(workdir, "docs");
  const docsMissing = !(await pathIsDirectory(docsPath));
  const readmeMissing = !(await pathIsFile(join(workdir, "README.md")));
  const docsReadmeMissing = !(await pathIsFile(join(workdir, "docs", "README.md")));

  let docsEmpty = false;
  if (!docsMissing) {
    try {
      const entries = await readdir(docsPath);
      docsEmpty = entries.filter((entry) => !entry.startsWith(".")).length === 0;
    } catch {
      docsEmpty = false;
    }
  }

  const hasGap = docsMissing || docsEmpty || readmeMissing || docsReadmeMissing;
  return { docsMissing, docsEmpty, readmeMissing, docsReadmeMissing, hasGap };
}

async function hasPendingDocserTask(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.role, "docser"), inArray(tasks.status, ["queued", "running", "blocked"])))
      .limit(1);
    return Boolean(row);
  } catch (error) {
    console.warn("[Planner] Failed to check pending docser tasks:", error);
    return false;
  }
}

function buildDocserTaskForGap(params: {
  requirement: Requirement;
  docGap: DocGapInfo;
  checkCommand?: string;
  dependsOnIndexes: number[];
}): PlannedTaskInput {
  const notes = [
    `要件: ${params.requirement.goal}`,
    "ドキュメント未整備を検知したためdocserで整備する。",
    `docGap: ${JSON.stringify(params.docGap)}`,
    "docs/README.md が存在しない場合は最小構成で作成する。",
  ].join("\n");
  const commands = params.checkCommand ? [params.checkCommand] : ["npm run check"];
  return {
    title: "ドキュメント整備",
    goal: "docs/README.md を含むドキュメントが実装と整合し、検証コマンドが成功する",
    role: "docser",
    context: {
      files: ["docs/README.md", "README.md", "docs/**"],
      notes,
    },
    allowedPaths: DOCSER_ALLOWED_PATHS,
    commands,
    priority: 5,
    riskLevel: "low",
    dependencies: [],
    dependsOnIndexes: params.dependsOnIndexes,
    timeboxMinutes: 45,
    targetArea: undefined,
    touches: [],
  };
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

async function getRootDevScript(workdir: string): Promise<string | undefined> {
  // ルートのpackage.jsonからdevスクリプトを取得する
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.dev === "string"
      ? parsed.scripts.dev
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDevVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  const devScript = await getRootDevScript(workdir);
  if (!devScript) {
    return undefined;
  }
  // turbo設定が無いのに `turbo ...` を検証で実行すると高確率で失敗するため除外
  if (/\bturbo\b/.test(devScript)) {
    const hasTurboConfig =
      await pathIsFile(join(workdir, "turbo.json"))
      || await pathIsFile(join(workdir, "turbo.jsonc"));
    if (!hasTurboConfig) {
      return undefined;
    }
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
    timeboxMinutes: 90,
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

function sanitizeTaskDependencyIndexes(result: TaskGenerationResult): TaskGenerationResult {
  let correctedTaskCount = 0;

  const tasks = result.tasks.map((task, index) => {
    const raw = task.dependsOnIndexes ?? [];
    const normalized = Array.from(
      new Set(
        raw.filter((dep) =>
          Number.isInteger(dep)
          && dep >= 0
          && dep < result.tasks.length
          && dep !== index
          && dep < index
        )
      )
    );

    if (normalized.length === raw.length) {
      return task;
    }

    correctedTaskCount++;
    return {
      ...task,
      dependsOnIndexes: normalized,
    };
  });

  if (correctedTaskCount === 0) {
    return result;
  }

  return {
    ...result,
    tasks,
    warnings: [
      ...result.warnings,
      `依存関係に循環/未来参照の可能性があったため ${correctedTaskCount} 件を補正しました。`,
    ],
  };
}

function ensureInitializationTaskForUninitializedRepo(
  result: TaskGenerationResult,
  requirement: Requirement,
  repoUninitialized: boolean
): TaskGenerationResult {
  if (!repoUninitialized) {
    return result;
  }

  let tasks = [...result.tasks];
  let initTaskIndex = tasks.findIndex((task) => isInitializationTask(task));
  let injected = false;

  if (initTaskIndex === -1) {
    const bootstrapTask = generateInitializationTasks(requirement).tasks[0];
    if (bootstrapTask) {
      // 先頭に差し込み、既存依存インデックスを1つ後ろへずらす
      const shiftedTasks = tasks.map((task) => ({
        ...task,
        dependsOnIndexes: (task.dependsOnIndexes ?? []).map((dep) => dep + 1),
      }));
      tasks = [bootstrapTask, ...shiftedTasks];
      initTaskIndex = 0;
      injected = true;
    }
  }

  if (initTaskIndex === -1) {
    return result;
  }

  const patchedTasks = tasks.map((task, index) => {
    if (index === initTaskIndex || isInitializationTask(task)) {
      return task;
    }

    const currentDepends = task.dependsOnIndexes ?? [];
    if (currentDepends.includes(initTaskIndex)) {
      return task;
    }

    const nextDepends = [...currentDepends, initTaskIndex]
      .filter((dep) => dep < index);

    return {
      ...task,
      dependsOnIndexes: Array.from(new Set(nextDepends)),
    };
  });

  const filteredWarnings = result.warnings.filter((warning) => {
    // 初期化タスクを補った後は「初期化未タスク化」警告を残さない
    return !(
      warning.includes("allowedPaths")
      && warning.includes("タスク化していません")
    );
  });

  const warnings = injected
    ? [
      ...filteredWarnings,
      "リポジトリ初期化タスクを自動追加し、他タスクはその完了に依存するよう補正しました。",
    ]
    : filteredWarnings;

  return {
    ...result,
    tasks: patchedTasks,
    warnings,
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
        role: input.role ?? "worker",
        targetArea: input.targetArea,
        touches: input.touches ?? [],
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
  signature?: { signature: string; requirementHash: string; repoHeadSha: string };
}): Promise<void> {
  const { requirementPath, requirement, result, savedIds, agentId, signature } = params;
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
        signature: signature?.signature,
        requirementHash: signature?.requirementHash,
        repoHeadSha: signature?.repoHeadSha,
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

function buildIssueTitle(task: PlannedTaskInput): string {
  return `[Task] ${task.title}`;
}

function buildIssueBody(params: {
  taskId: string;
  task: PlannedTaskInput;
  requirement: Requirement;
}): string {
  const { taskId, task, requirement } = params;
  const role = task.role ?? "worker";
  const riskLevel = task.riskLevel ?? "low";
  const timebox = task.timeboxMinutes ?? 60;
  const notes = task.context?.notes?.trim();
  const specs = task.context?.specs?.trim();
  const files = task.context?.files ?? [];
  const allowedPaths = task.allowedPaths ?? [];
  const commands = task.commands ?? [];

  const lines: string[] = [
    "## Task",
    "",
    `- Task ID: \`${taskId}\``,
    `- Role: ${role}`,
    `- Risk Level: ${riskLevel}`,
    `- Timebox: ${timebox} minutes`,
    "",
    "## Goal",
    "",
    task.goal,
    "",
    "## Requirement",
    "",
    requirement.goal,
    "",
    "## Allowed Paths",
    "",
  ];

  if (allowedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const path of allowedPaths) {
      lines.push(`- ${path}`);
    }
  }

  lines.push("", "## Commands", "");

  if (commands.length === 0) {
    lines.push("- (none)");
  } else {
    for (const command of commands) {
      lines.push(`- \`${command}\``);
    }
  }

  if (files.length > 0) {
    lines.push("", "## Related Files", "");
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }

  if (specs) {
    lines.push("", "## Specs", "", specs);
  }

  if (notes) {
    lines.push("", "## Notes", "", notes);
  }

  lines.push("", "---", "", "このIssueはPlannerが自動生成しました。");

  return lines.join("\n");
}

async function createIssuesForTasks(params: {
  requirement: Requirement;
  tasks: PlannedTaskInput[];
  savedIds: string[];
}): Promise<void> {
  if (getRepoMode() !== "git") {
    return;
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    console.warn("[Planner] GitHub設定がないためIssue作成をスキップします。");
    return;
  }

  const { requirement, tasks: taskInputs, savedIds } = params;

  // Plannerで生成したタスクをIssue化して追跡しやすくする
  for (let index = 0; index < taskInputs.length; index += 1) {
    const task = taskInputs[index];
    const taskId = savedIds[index];
    if (!task || !taskId) continue;
    if (task.context?.issue?.number) {
      continue;
    }

    try {
      const issue = await createIssue({
        title: buildIssueTitle(task),
        body: buildIssueBody({ taskId, task, requirement }),
      });

      const updatedContext = {
        ...(task.context ?? {}),
        issue: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
        },
      };

      await db
        .update(tasks)
        .set({ context: updatedContext, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Planner] Failed to create issue for task ${taskId}: ${message}`);
    }
  }
}

// 要件ファイルからタスクを生成
async function planFromRequirement(
  requirementPath: string,
  config: PlannerConfig,
  agentId: string
): Promise<void> {
  console.log("=".repeat(60));
  console.log("sebastian-code Planner - Task Generation");
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read requirement file: ${message}`);
  }

  // 要件を検証
  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    console.error("Validation errors:");
    for (const error of validationErrors) {
      console.error(`  - ${error}`);
    }
    throw new Error("Validation failed");
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
  const checkCommand = await resolveCheckVerificationCommand(config.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(config.workdir);
  const repoUninitialized = await isRepoUninitialized(config.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;

  if (!repoUninitialized && !config.useLlm) {
    console.error("[Planner] 差分点検が必須のため、LLMを無効化できません。");
    throw new Error("LLM cannot be disabled when inspection is required");
  }

  if (repoUninitialized) {
    // 空リポジトリでも要件に基づいてLLMにタスクを分割させる
    console.log("\n[Planner] Repository is not initialized. Using LLM to plan from scratch.");
    // 差分点検は不要だが「すべてが未実装」と明示する
    const emptyInspection: CodebaseInspection = {
      summary: "リポジトリが空のため、要件のすべてが未実装です。",
      satisfied: [],
      gaps: requirement.acceptanceCriteria.map((c) => `未実装: ${c}`),
      evidence: [],
      notes: ["リポジトリにはファイルが存在しないため、すべてを新規作成する必要があります。"],
    };
    inspectionResult = emptyInspection;
    inspectionNotes = formatInspectionNotes(emptyInspection);
    requirement = attachInspectionToRequirement(requirement, inspectionNotes);
  } else {
    if (!config.inspectCodebase) {
      console.log("[Planner] 差分点検は必須のため有効化します。");
    }
    const inspectionTimeout = config.inspectionTimeoutSeconds;
    console.log(`\n[Planner] Inspecting codebase with LLM... (timeout: ${inspectionTimeout}s)`);
    // LLM応答待ちで無応答に見えるのを避けるため、経過時間を定期的にログに出す
    const inspectionStart = Date.now();
    const inspectionHeartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - inspectionStart) / 1000);
      console.log(`[Planner] Inspection in progress... (${elapsed}s elapsed)`);
    }, 30000);
    let inspection: CodebaseInspection | undefined;
    try {
      inspection = await inspectCodebase(requirement, {
        workdir: config.workdir,
        timeoutSeconds: inspectionTimeout,
      });
    } finally {
      clearInterval(inspectionHeartbeat);
      const elapsed = Math.round((Date.now() - inspectionStart) / 1000);
      console.log(`[Planner] Inspection finished in ${elapsed}s`);
    }
    if (!inspection) {
      console.error("[Planner] 差分点検に失敗したためタスク生成を中断します。");
      throw new Error("Inspection failed");
    }
    inspectionResult = inspection;
    inspectionNotes = formatInspectionNotes(inspection);
    requirement = attachInspectionToRequirement(requirement, inspectionNotes);
  }

  // タスクを生成
  let result: TaskGenerationResult;

  if (config.useLlm) {
    console.log(`\n[Generating tasks with LLM...] (timeout: ${config.timeoutSeconds}s)`);
    const genStart = Date.now();
    const genHeartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - genStart) / 1000);
      console.log(`[Planner] Task generation in progress... (${elapsed}s elapsed)`);
    }, 30000);
    try {
      result = await generateTasksFromRequirement(requirement, {
        workdir: config.workdir,
        instructionsPath: config.instructionsPath,
        timeoutSeconds: config.timeoutSeconds,
        inspection: inspectionResult,
      });
    } finally {
      clearInterval(genHeartbeat);
      const elapsed = Math.round((Date.now() - genStart) / 1000);
      console.log(`[Planner] Task generation finished in ${elapsed}s`);
    }
  } else {
    console.log("\n[Generating tasks without LLM...]");
    result = generateSimpleTasks(requirement);
  }

  result = ensureInitializationTaskForUninitializedRepo(
    result,
    requirement,
    repoUninitialized
  );

  const docGap = !repoUninitialized ? await detectDocGap(config.workdir) : undefined;
  if (docGap?.hasGap && !(await hasPendingDocserTask())) {
    const dependsOnIndexes = result.tasks.map((_, index) => index);
    const docserTask = buildDocserTaskForGap({
      requirement,
      docGap,
      checkCommand,
      dependsOnIndexes,
    });
    result = {
      ...result,
      tasks: [...result.tasks, docserTask],
      warnings: [
        ...result.warnings,
        "ドキュメントが未整備のためdocserタスクを追加しました。",
      ],
    };
  }

  result = sanitizeTaskDependencyIndexes(result);
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

  const planSignature = await computePlanSignature({
    requirementPath,
    workdir: config.workdir,
    repoUrl: config.repoUrl,
    baseBranch: config.baseBranch,
  });

  const dedupeWindowMs = resolvePlanDedupeWindowMs();
  if (planSignature?.signature) {
    const acquired = await tryAcquirePlanSaveLock(planSignature.signature);
    if (!acquired) {
      console.log("\n[Planner] 同一署名のPlan保存が進行中のため、保存をスキップします。");
      return;
    }
    try {
      if (await wasPlanRecentlyCreated(planSignature.signature, dedupeWindowMs)) {
        console.log("\n[Planner] 同一署名のPlanが直近に作成済みのため、保存をスキップします。");
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
        signature: planSignature,
      });

      await createIssuesForTasks({
        requirement,
        tasks: result.tasks,
        savedIds,
      });

      console.log(`\nSaved ${savedIds.length} tasks to database`);
      console.log("Task IDs:");
      for (const id of savedIds) {
        console.log(`  - ${id}`);
      }

      console.log("\n" + "=".repeat(60));
      console.log("Planning complete!");
      console.log("=".repeat(60));
      return;
    } finally {
      await releasePlanSaveLock(planSignature.signature);
    }
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
    signature: planSignature,
  });

  await createIssuesForTasks({
    requirement,
    tasks: result.tasks,
    savedIds,
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
  const tempDir = await mkdtemp(join(tmpdir(), "sebastian-code-planner-"));
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
  const checkCommand = await resolveCheckVerificationCommand(fullConfig.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(fullConfig.workdir);
  const repoUninitialized = await isRepoUninitialized(fullConfig.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;

  if (!repoUninitialized && !fullConfig.useLlm) {
    throw new Error("差分点検が必須のため、LLMを無効化できません。");
  }

  if (!repoUninitialized) {
    if (!fullConfig.inspectCodebase) {
      console.log("[Planner] 差分点検は必須のため有効化します。");
    }
    const inspection = await inspectCodebase(requirement, {
      workdir: fullConfig.workdir,
      timeoutSeconds: fullConfig.inspectionTimeoutSeconds,
    });
    if (!inspection) {
      throw new Error("差分点検に失敗したためタスク生成を中断します。");
    }
    inspectionResult = inspection;
    inspectionNotes = formatInspectionNotes(inspection);
    requirement = attachInspectionToRequirement(requirement, inspectionNotes);
  }

  if (repoUninitialized) {
    return attachInspectionToTasks(
      attachJudgeFeedbackToTasks(
        applyDevCommandPolicy(
          applyTesterCommandPolicy(
            applyVerificationCommandPolicy(
              applyTaskRolePolicy(
                normalizeGeneratedTasks(
                  sanitizeTaskDependencyIndexes(generateInitializationTasks(requirement))
                )
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
    let result = await generateTasksFromRequirement(requirement, {
      workdir: fullConfig.workdir,
      instructionsPath: fullConfig.instructionsPath,
      timeoutSeconds: fullConfig.timeoutSeconds,
      inspection: inspectionResult,
    });
    const docGap = !repoUninitialized ? await detectDocGap(fullConfig.workdir) : undefined;
    if (docGap?.hasGap && !(await hasPendingDocserTask())) {
      const dependsOnIndexes = result.tasks.map((_, index) => index);
      const docserTask = buildDocserTaskForGap({
        requirement,
        docGap,
        checkCommand,
        dependsOnIndexes,
      });
      result = {
        ...result,
        tasks: [...result.tasks, docserTask],
        warnings: [
          ...result.warnings,
          "ドキュメントが未整備のためdocserタスクを追加しました。",
        ],
      };
    }
    result = sanitizeTaskDependencyIndexes(result);
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
  }

  return attachInspectionToTasks(
    attachJudgeFeedbackToTasks(
      applyDevCommandPolicy(
        applyTesterCommandPolicy(
          applyVerificationCommandPolicy(
            applyTaskRolePolicy(
              normalizeGeneratedTasks(
                sanitizeTaskDependencyIndexes(generateSimpleTasks(requirement))
              )
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

// ヘルプを表示
function showHelp(): void {
  console.log(`
sebastian-code Planner - Generate tasks from requirements

Usage:
  pnpm --filter @sebastian-code/planner start <requirement.md>
  pnpm --filter @sebastian-code/planner start --help

Options:
  --help          Show this help message
  --dry-run       Generate tasks but don't save to database
  --no-llm        差分点検が必須のため初期化以外では利用不可

Environment Variables:
  USE_LLM=false         Disable LLM generation
  DRY_RUN=true          Enable dry run mode
  PLANNER_TIMEOUT=300   LLM timeout in seconds
  PLANNER_MODEL=xxx     Planner LLM model
  PLANNER_INSPECT=false 差分点検は必須のため無視される
  PLANNER_INSPECT_TIMEOUT=180  LLM inspection timeout in seconds

Example:
  pnpm --filter @sebastian-code/planner start docs/requirements/feature-x.md
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

  await db.insert(agents).values({
    id: agentId,
    role: "planner",
    // 再計画の重複起動を避けるため、起動直後からbusyとして扱う
    status: "busy",
    lastHeartbeat: new Date(),
    metadata: {
      model: plannerModel, // Plannerは高精度モデルで計画品質を優先する
      provider: "gemini",
    },
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      status: "busy",
      lastHeartbeat: new Date(),
    },
  });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);

  // 引数がない場合は環境変数の要件パスを利用する
  try {
    const requirementPath = args.find((arg) => !arg.startsWith("--"))
      ?? process.env.REQUIREMENT_PATH
      ?? process.env.REPLAN_REQUIREMENT_PATH;

    if (!requirementPath) {
      console.error("Error: Requirement file path is required");
      showHelp();
      throw new Error("Requirement file path is required");
    }

    // ファイルの存在確認
    try {
      await stat(requirementPath);
    } catch {
      console.error(`Error: File not found: ${requirementPath}`);
      throw new Error(`File not found: ${requirementPath}`);
    }

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
