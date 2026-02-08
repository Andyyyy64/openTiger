import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@openTiger/db";
import { artifacts, config as configTable, events, runs, tasks } from "@openTiger/db/schema";
import { configToEnv, DEFAULT_CONFIG, buildConfigRecord } from "../system-config.js";
import { getAuthInfo } from "../middleware/index.js";
import { createRepo, getOctokit, getRepoInfo } from "@openTiger/vcs";
import { obliterateAllQueues } from "@openTiger/queue";

type RestartStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  message?: string;
};

type ProcessStatus = "idle" | "running" | "completed" | "failed" | "stopped";
type ProcessKind = "service" | "worker" | "planner" | "database" | "command";

type ProcessInfo = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
};

type ProcessRuntime = {
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
  process?: ChildProcess | null;
  stopRequested?: boolean;
  lastPayload?: StartPayload;
  restartAttempts?: number;
  restartWindowStartedAt?: number;
  restartScheduled?: boolean;
};

type StartPayload = {
  requirementPath?: string;
  content?: string;
};

type StartCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ProcessDefinition = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  autoRestart?: boolean;
  buildStart: (payload: StartPayload) => Promise<StartCommand>;
};

const systemRoute = new Hono();

let restartProcess: ChildProcess | null = null;
let restartStatus: RestartStatus = { status: "idle" };
const managedProcesses = new Map<string, ProcessRuntime>();
const processStartLocks = new Set<string>();
const AUTO_RESTART_ENABLED = process.env.SYSTEM_PROCESS_AUTO_RESTART !== "false";
const AUTO_RESTART_DELAY_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS ?? "2000",
  10
);
const AUTO_RESTART_WINDOW_MS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS ?? "300000",
  10
);
const AUTO_RESTART_MAX_ATTEMPTS = Number.parseInt(
  process.env.SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS ?? "5",
  10
);

type GitHubContext = {
  token: string;
  owner: string;
  repo: string;
};
type ConfigRow = typeof configTable.$inferSelect;

type OpenIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

type OpenPrSnapshot = {
  count: number;
  linkedIssueNumbers: Set<number>;
  openPulls: Array<{
    number: number;
    title: string;
    body: string;
    url: string;
  }>;
};

type TaskIssueLink = {
  id: string;
  status: string;
  updatedAt: Date;
};

type SystemPreflightSummary = {
  github: {
    enabled: boolean;
    openIssueCount: number;
    openPrCount: number;
    issueTaskBacklogCount: number;
    generatedTaskCount: number;
    generatedTaskIds: string[];
    skippedIssueNumbers: number[];
    warnings: string[];
  };
  local: {
    queuedTaskCount: number;
    runningTaskCount: number;
    failedTaskCount: number;
    blockedTaskCount: number;
    pendingJudgeTaskCount: number;
  };
};

function parseBooleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() !== "false";
}

function parseCountSetting(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

function resolveLogDir(): string {
  if (process.env.OPENTIGER_LOG_DIR) {
    return process.env.OPENTIGER_LOG_DIR;
  }
  if (process.env.OPENTIGER_RAW_LOG_DIR) {
    return process.env.OPENTIGER_RAW_LOG_DIR;
  }
  return join(resolveRepoRoot(), "raw-logs");
}

function canControlSystem(method: string): boolean {
  if (method === "api-key" || method === "bearer") {
    return true;
  }
  // 認証が無効な環境ではUIからの操作を許可する
  const hasApiSecret = Boolean(process.env.API_SECRET?.trim());
  const hasApiKeys = Boolean(process.env.API_KEYS?.trim());
  if (!hasApiSecret && !hasApiKeys) {
    return true;
  }
  // 開発環境でUIから試せるようにするための最低限の安全弁
  return process.env.OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL === "true";
}

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolvePathInRepo(rawPath: string): string {
  const baseDir = resolveRepoRoot();
  const resolved = resolve(baseDir, rawPath);
  // リポジトリ外のファイル操作を避ける
  if (!isSubPath(baseDir, resolved)) {
    throw new Error("Path must be within repository");
  }
  return resolved;
}

async function resolveRequirementPath(
  input?: string,
  fallback?: string,
  options: { allowMissing?: boolean } = {}
): Promise<string> {
  // UIからの入力と環境変数を統一的に扱う
  const candidate = input?.trim()
    || process.env.REQUIREMENT_PATH
    || process.env.REPLAN_REQUIREMENT_PATH
    || fallback;
  if (!candidate) {
    throw new Error("Requirement file path is required");
  }
  const resolved = resolvePathInRepo(candidate);
  if (!options.allowMissing) {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      throw new Error("Requirement file must be a file");
    }
  }
  return resolved;
}

async function writeRequirementFile(path: string, content: string): Promise<void> {
  // Plannerに渡す要件ファイルを保存する
  await mkdir(dirname(path), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(path, normalized, "utf-8");
}

async function readRequirementFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

function describeCommand(command: StartCommand): string {
  return [command.command, ...command.args].join(" ");
}

function resolveGitHubContext(configRow: ConfigRow): GitHubContext | null {
  const token = configRow.githubToken?.trim();
  const owner = configRow.githubOwner?.trim();
  const repo = configRow.githubRepo?.trim();
  if (!token || !owner || !repo) {
    return null;
  }
  return { token, owner, repo };
}

function normalizeAllowedPathToken(token: string): string[] {
  let value = token.trim();
  value = value.replace(/^`+|`+$/g, "");
  value = value.replace(/^"+|"+$/g, "");
  value = value.replace(/^'+|'+$/g, "");
  value = value.replace(/^\.\//, "");
  value = value.trim();

  if (!value || value === "." || value === "/" || value === "./") {
    return ["**"];
  }
  if (value.includes("*")) {
    return [value];
  }
  if (value.endsWith("/")) {
    value = value.slice(0, -1);
  }

  const basename = value.split("/").pop() ?? value;
  const looksLikeFile = basename.includes(".");
  if (looksLikeFile) {
    return [value];
  }
  return [value, `${value}/**`];
}

function parseAllowedPathsFromIssueBody(body: string): string[] {
  if (!body) {
    return ["**"];
  }
  const lines = body.split(/\r?\n/);
  const tokens: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s*allowed\s*paths?\b/i.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s+/.test(trimmed)) {
      break;
    }
    if (!inSection) {
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch?.[1]) {
      tokens.push(bulletMatch[1]);
      continue;
    }
    if (trimmed.length > 0) {
      tokens.push(trimmed);
    }
  }

  if (tokens.length === 0) {
    const inlineMatch = body.match(/allowed\s*paths?\s*:\s*([^\n]+)/i);
    if (inlineMatch?.[1]) {
      tokens.push(...inlineMatch[1].split(","));
    }
  }

  const normalized = new Set<string>();
  for (const token of tokens) {
    for (const value of normalizeAllowedPathToken(token)) {
      normalized.add(value);
    }
  }

  if (normalized.size === 0) {
    normalized.add("**");
  }
  return Array.from(normalized);
}

function parseIssueNumberRefs(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?:#|\/issues\/)(\d{1,10})\b/g)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      numbers.add(parsed);
    }
  }
  return Array.from(numbers);
}

function parseDependencyIssueNumbersFromIssueBody(body: string): number[] {
  if (!body) {
    return [];
  }

  const numbers = new Set<number>();
  const lines = body.split(/\r?\n/);
  let inDependencySection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (/^#{1,6}\s*(dependencies?|depends\s*on|blocked\s*by|dependency|依存関係)\b/i.test(trimmed)) {
      inDependencySection = true;
      continue;
    }
    if (inDependencySection && /^#{1,6}\s+/.test(trimmed)) {
      inDependencySection = false;
    }

    if (inDependencySection) {
      for (const number of parseIssueNumberRefs(trimmed)) {
        numbers.add(number);
      }
      continue;
    }

    if (/(depends?\s*on|blocked\s*by|requires?|dependency|依存)/i.test(trimmed)) {
      for (const number of parseIssueNumberRefs(trimmed)) {
        numbers.add(number);
      }
    }
  }

  return Array.from(numbers);
}

function inferRoleFromLabels(labels: string[]): "worker" | "tester" | "docser" {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => label.includes("docs") || label.includes("docser"))) {
    return "docser";
  }
  if (lower.some((label) => label.includes("test") || label.includes("qa") || label.includes("e2e"))) {
    return "tester";
  }
  return "worker";
}

function inferRiskFromLabels(labels: string[]): "low" | "medium" | "high" {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => label.includes("critical") || label.includes("security") || label.includes("urgent"))) {
    return "high";
  }
  if (lower.some((label) => label.includes("bug") || label.includes("important") || label.includes("fix"))) {
    return "medium";
  }
  return "low";
}

function inferPriorityFromLabels(labels: string[]): number {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => label.includes("priority:high") || label.includes("p0") || label.includes("p1"))) {
    return 90;
  }
  if (lower.some((label) => label.includes("priority:medium") || label.includes("p2"))) {
    return 60;
  }
  return 40;
}

function extractIssueNumberFromTaskContext(context: unknown): number | null {
  if (!context || typeof context !== "object") {
    return null;
  }
  const issue = (context as { issue?: unknown }).issue;
  if (!issue || typeof issue !== "object") {
    return null;
  }
  const number = (issue as { number?: unknown }).number;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    return null;
  }
  return number;
}

async function resolveIssueTaskCommands(): Promise<string[]> {
  const repoRoot = resolveRepoRoot();
  try {
    const raw = await readFile(join(repoRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    if (typeof scripts.check === "string") {
      return ["pnpm run check"];
    }
    if (typeof scripts.test === "string") {
      return ["pnpm test"];
    }
    if (typeof scripts.typecheck === "string") {
      return ["pnpm run typecheck"];
    }
  } catch {
    // 取得できない場合は安全側のデフォルトへフォールバック
  }
  return ["pnpm -r --if-present test"];
}

async function fetchOpenIssues(context: GitHubContext): Promise<OpenIssueSnapshot[]> {
  const octokit = getOctokit({ token: context.token });
  const { owner, repo } = getRepoInfo({
    owner: context.owner,
    repo: context.repo,
  });

  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  return rows
    .filter((row) => !row.pull_request)
    .map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      url: row.html_url,
      labels: row.labels
        .map((label) =>
          typeof label === "string" ? label : (label.name ?? "")
        )
        .filter((label): label is string => label.length > 0),
    }));
}

async function fetchOpenPrCount(context: GitHubContext): Promise<OpenPrSnapshot> {
  const octokit = getOctokit({ token: context.token });
  const { owner, repo } = getRepoInfo({
    owner: context.owner,
    repo: context.repo,
  });
  const rows = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const linkedIssueNumbers = new Set<number>();
  for (const row of rows) {
    const title = row.title ?? "";
    const body = row.body ?? "";
    for (const issueNumber of parseLinkedIssueNumbersFromPr(title, body)) {
      linkedIssueNumbers.add(issueNumber);
    }
  }

  return {
    count: rows.length,
    linkedIssueNumbers,
    openPulls: rows.map((row) => ({
      number: row.number,
      title: row.title ?? "",
      body: row.body ?? "",
      url: row.html_url,
    })),
  };
}

function parseLinkedIssueNumbersFromPr(title: string, body: string): number[] {
  const numbers = new Set<number>();
  const lines = `${title}\n${body}`.split(/\r?\n/);

  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }

    if (
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|related|issue|closes|fixes|resolves)\b/i.test(
        normalized
      )
    ) {
      for (const issueNumber of parseIssueNumberRefs(normalized)) {
        numbers.add(issueNumber);
      }
    }
  }

  // 1行に複数 closing keyword が来るケースを拾う
  for (const match of `${title}\n${body}`.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b([^\n]+)/gi
  )) {
    for (const issueNumber of parseIssueNumberRefs(match[1] ?? "")) {
      numbers.add(issueNumber);
    }
  }

  return Array.from(numbers);
}

async function createTaskFromIssue(
  issue: OpenIssueSnapshot,
  commands: string[],
  dependencyTaskIds: string[] = []
): Promise<string | null> {
  const allowedPaths = parseAllowedPathsFromIssueBody(issue.body);
  const role = inferRoleFromLabels(issue.labels);
  const riskLevel = inferRiskFromLabels(issue.labels);
  const priority = inferPriorityFromLabels(issue.labels);
  const notes = `Imported from GitHub Issue #${issue.number}`;

  const [created] = await db
    .insert(tasks)
    .values({
      title: issue.title,
      goal: `Resolve GitHub Issue #${issue.number} and make it closable via PR.`,
      context: {
        specs: issue.body || undefined,
        notes,
        issue: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
        },
      },
      allowedPaths,
      commands,
      dependencies: dependencyTaskIds,
      priority,
      riskLevel,
      role,
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!created?.id) {
    return null;
  }

  await db.insert(events).values({
    type: "task.created_from_issue",
    entityType: "task",
    entityId: created.id,
    agentId: "system",
    payload: {
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueTitle: issue.title,
      labels: issue.labels,
    },
  });

  return created.id;
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

function pickDependencyTaskId(links: TaskIssueLink[]): string | null {
  const statusWeight: Record<string, number> = {
    running: 0,
    queued: 1,
    blocked: 2,
    failed: 3,
  };

  const candidates = links
    .filter((link) => !isTerminalTaskStatus(link.status))
    .sort((a, b) => {
      const weightDiff = (statusWeight[a.status] ?? 99) - (statusWeight[b.status] ?? 99);
      if (weightDiff !== 0) {
        return weightDiff;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

  if (candidates.length === 0) {
    return null;
  }
  return candidates[0]?.id ?? null;
}

async function buildPreflightSummary(options: {
  configRow: ConfigRow;
  autoCreateIssueTasks: boolean;
  autoCreatePrJudgeTasks: boolean;
}): Promise<SystemPreflightSummary> {
  const taskRows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      blockReason: tasks.blockReason,
      context: tasks.context,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks);

  let queuedTaskCount = 0;
  let runningTaskCount = 0;
  let failedTaskCount = 0;
  let blockedTaskCount = 0;
  let pendingJudgeTaskCount = 0;
  const issueTaskMap = new Map<number, TaskIssueLink[]>();

  for (const row of taskRows) {
    if (row.status === "queued") queuedTaskCount += 1;
    if (row.status === "running") runningTaskCount += 1;
    if (row.status === "failed") failedTaskCount += 1;
    if (row.status === "blocked") {
      blockedTaskCount += 1;
      if (row.blockReason === "awaiting_judge") {
        pendingJudgeTaskCount += 1;
      }
    }

    const issueNumber = extractIssueNumberFromTaskContext(row.context);
    if (!issueNumber) continue;
    const current = issueTaskMap.get(issueNumber) ?? [];
    current.push({
      id: row.id,
      status: row.status,
      updatedAt: row.updatedAt,
    });
    issueTaskMap.set(issueNumber, current);
  }

  const summary: SystemPreflightSummary = {
    github: {
      enabled: false,
      openIssueCount: 0,
      openPrCount: 0,
      issueTaskBacklogCount: 0,
      generatedTaskCount: 0,
      generatedTaskIds: [],
      skippedIssueNumbers: [],
      warnings: [],
    },
    local: {
      queuedTaskCount,
      runningTaskCount,
      failedTaskCount,
      blockedTaskCount,
      pendingJudgeTaskCount,
    },
  };

  if ((options.configRow.repoMode ?? "git").toLowerCase() !== "git") {
    summary.github.warnings.push("REPO_MODE is not git. Skipping GitHub issue/PR preflight.");
    return summary;
  }

  const githubContext = resolveGitHubContext(options.configRow);
  if (!githubContext) {
    summary.github.warnings.push(
      "GitHub token/owner/repo is not fully configured. Skipping issue and PR preflight."
    );
    return summary;
  }

  summary.github.enabled = true;
  let prLinkedIssueNumbers = new Set<number>();
  let openPulls: Array<{ number: number; title: string; body: string; url: string }> = [];

  let openIssues: OpenIssueSnapshot[] = [];
  try {
    const [issues, openPrSnapshot] = await Promise.all([
      fetchOpenIssues(githubContext),
      fetchOpenPrCount(githubContext),
    ]);
    openIssues = issues;
    summary.github.openIssueCount = issues.length;
    summary.github.openPrCount = openPrSnapshot.count;
    prLinkedIssueNumbers = openPrSnapshot.linkedIssueNumbers;
    openPulls = openPrSnapshot.openPulls;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.github.warnings.push(`Failed to query GitHub backlog: ${message}`);
    return summary;
  }

  const commands = options.autoCreateIssueTasks
    ? await resolveIssueTaskCommands()
    : [];
  const generatedIssueTaskIds = new Map<number, string>();

  for (const issue of openIssues) {
    if (prLinkedIssueNumbers.has(issue.number)) {
      summary.github.skippedIssueNumbers.push(issue.number);
      continue;
    }

    const linkedTasks = issueTaskMap.get(issue.number) ?? [];
    const isDone = linkedTasks.some((task) => task.status === "done");
    const hasOngoingTask = linkedTasks.some(
      (task) => task.status !== "done" && task.status !== "cancelled"
    );

    if (isDone) {
      summary.github.skippedIssueNumbers.push(issue.number);
      continue;
    }

    if (hasOngoingTask) {
      summary.github.issueTaskBacklogCount += 1;
      continue;
    }

    if (!options.autoCreateIssueTasks) {
      summary.github.issueTaskBacklogCount += 1;
      continue;
    }

    const createdTaskId = await createTaskFromIssue(issue, commands);
    if (createdTaskId) {
      generatedIssueTaskIds.set(issue.number, createdTaskId);
      const current = issueTaskMap.get(issue.number) ?? [];
      current.push({
        id: createdTaskId,
        status: "queued",
        updatedAt: new Date(),
      });
      issueTaskMap.set(issue.number, current);
      summary.github.generatedTaskCount += 1;
      summary.github.generatedTaskIds.push(createdTaskId);
      summary.github.issueTaskBacklogCount += 1;
    } else {
      summary.github.warnings.push(`Failed to create task for issue #${issue.number}.`);
    }
  }

  if (generatedIssueTaskIds.size > 0) {
    for (const issue of openIssues) {
      const taskId = generatedIssueTaskIds.get(issue.number);
      if (!taskId) {
        continue;
      }

      const dependencyIssueNumbers = parseDependencyIssueNumbersFromIssueBody(issue.body).filter(
        (number) => number !== issue.number
      );
      if (dependencyIssueNumbers.length === 0) {
        continue;
      }

      const dependencyTaskIds = Array.from(
        new Set(
          dependencyIssueNumbers
            .map((number) => pickDependencyTaskId(issueTaskMap.get(number) ?? []))
            .filter((value): value is string => Boolean(value))
        )
      );

      const missingIssueNumbers = dependencyIssueNumbers.filter(
        (number) => !issueTaskMap.has(number)
      );
      if (missingIssueNumbers.length > 0) {
        summary.github.warnings.push(
          `Issue #${issue.number} references missing dependencies: ${missingIssueNumbers
            .map((number) => `#${number}`)
            .join(", ")}`
        );
      }

      if (dependencyTaskIds.length === 0) {
        continue;
      }

      await db
        .update(tasks)
        .set({ dependencies: dependencyTaskIds, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      await db.insert(events).values({
        type: "task.dependencies_set_from_issue",
        entityType: "task",
        entityId: taskId,
        agentId: "system",
        payload: {
          issueNumber: issue.number,
          dependencyIssueNumbers,
          dependencyTaskIds,
        },
      });
    }
  }

  if (options.autoCreatePrJudgeTasks && openPulls.length > 0) {
    const openPrRefs = openPulls.map((pull) => String(pull.number));
    const trackedRows = await db
      .select({
        ref: artifacts.ref,
      })
      .from(artifacts)
      .where(and(eq(artifacts.type, "pr"), inArray(artifacts.ref, openPrRefs)));
    const trackedPrNumbers = new Set<number>();
    for (const row of trackedRows) {
      const parsed = Number.parseInt(row.ref ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        trackedPrNumbers.add(parsed);
      }
    }

    let importedPrCount = 0;
    for (const pull of openPulls) {
      if (trackedPrNumbers.has(pull.number)) {
        continue;
      }

      const [taskRow] = await db
        .insert(tasks)
        .values({
          title: `[PR] Review #${pull.number}: ${pull.title || "Untitled PR"}`,
          goal: `Review and process open PR #${pull.number}.`,
          context: {
            notes: "Imported from open GitHub PR backlog",
            pr: {
              number: pull.number,
              url: pull.url,
              title: pull.title,
            },
          },
          allowedPaths: ["**"],
          commands: [],
          dependencies: [],
          priority: 50,
          riskLevel: "low",
          role: "worker",
          status: "blocked",
          blockReason: "awaiting_judge",
          timeboxMinutes: 30,
        })
        .returning({ id: tasks.id });

      if (!taskRow?.id) {
        summary.github.warnings.push(`Failed to import open PR #${pull.number} into local backlog.`);
        continue;
      }

      const now = new Date();
      const [runRow] = await db
        .insert(runs)
        .values({
          taskId: taskRow.id,
          agentId: "system",
          status: "success",
          startedAt: now,
          finishedAt: now,
        })
        .returning({ id: runs.id });

      if (!runRow?.id) {
        summary.github.warnings.push(`Failed to create run for imported PR #${pull.number}.`);
        continue;
      }

      await db.insert(artifacts).values({
        runId: runRow.id,
        type: "pr",
        ref: String(pull.number),
        url: pull.url,
        metadata: {
          title: pull.title,
          imported: true,
        },
      });

      await db.insert(events).values({
        type: "task.created_from_open_pr",
        entityType: "task",
        entityId: taskRow.id,
        agentId: "system",
        payload: {
          prNumber: pull.number,
          prUrl: pull.url,
          prTitle: pull.title,
        },
      });

      importedPrCount += 1;
      summary.local.blockedTaskCount += 1;
      summary.local.pendingJudgeTaskCount += 1;
    }

    if (importedPrCount > 0) {
      summary.github.warnings.push(`Imported ${importedPrCount} open PR(s) into judge backlog.`);
    }
  }

  return summary;
}

const MAX_WORKER_PROCESSES = 10;
const MAX_TESTER_PROCESSES = 10;
const MAX_DOCSER_PROCESSES = 10;
const MAX_JUDGE_PROCESSES = 4;
const MAX_PLANNER_PROCESSES = 2;

function buildPlannerDefinitions(): ProcessDefinition[] {
  return Array.from({ length: MAX_PLANNER_PROCESSES }, (_, i) => i + 1).map((index) => {
    const name = index === 1 ? "planner" : `planner-${index}`;
    return {
      name,
      label: index === 1 ? "Planner" : `Planner #${index}`,
      description: "requirementsからタスクを生成",
      group: "Planner",
      kind: "planner",
      supportsStop: true,
      buildStart: async (payload) => {
        const requirementPath = await resolveRequirementPath(
          payload.requirementPath,
          "requirement.md",
          { allowMissing: Boolean(payload.content) }
        );
        if (payload.content) {
          await writeRequirementFile(requirementPath, payload.content);
        }
        return {
          command: "pnpm",
          args: ["--filter", "@openTiger/planner", "dev", requirementPath],
          cwd: resolveRepoRoot(),
          env: { AGENT_ID: `planner-${index}` },
        };
      },
    } as ProcessDefinition;
  });
}

function buildJudgeDefinitions(): ProcessDefinition[] {
  return Array.from({ length: MAX_JUDGE_PROCESSES }, (_, i) => i + 1).map((index) => {
    const name = index === 1 ? "judge" : `judge-${index}`;
    return {
      name,
      label: index === 1 ? "Judge" : `Judge #${index}`,
      description: "レビュー判定の常駐プロセス",
      group: "Core",
      kind: "service",
      supportsStop: true,
      autoRestart: true,
      buildStart: async () => ({
        command: "pnpm",
        args: ["--filter", "@openTiger/judge", "dev"],
        cwd: resolveRepoRoot(),
        env: { AGENT_ID: `judge-${index}` },
      }),
    } as ProcessDefinition;
  });
}

const processDefinitions: ProcessDefinition[] = [
  ...buildPlannerDefinitions(),
  {
    name: "dispatcher",
    label: "Dispatcher",
    description: "タスク割当の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/dispatcher", "dev"],
      cwd: resolveRepoRoot(),
    }),
  },
  ...buildJudgeDefinitions(),
  {
    name: "cycle-manager",
    label: "Cycle Manager",
    description: "長時間運用の管理プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/cycle-manager", "dev"],
      cwd: resolveRepoRoot(),
    }),
  },
  ...Array.from({ length: MAX_WORKER_PROCESSES }, (_, i) => i + 1).map((index) => ({
    name: `worker-${index}`,
    label: `Worker #${index}`,
    description: "実装ワーカー",
    group: "Workers",
    kind: "worker" as const,
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: String(index), AGENT_ROLE: "worker" },
    }),
  })),
  ...Array.from({ length: MAX_TESTER_PROCESSES }, (_, i) => i + 1).map((index) => ({
    name: `tester-${index}`,
    label: `Tester #${index}`,
    description: "テスト専用ワーカー",
    group: "Workers",
    kind: "worker" as const,
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: String(index), AGENT_ROLE: "tester" },
    }),
  })),
  ...Array.from({ length: MAX_DOCSER_PROCESSES }, (_, i) => i + 1).map((index) => ({
    name: `docser-${index}`,
    label: index === 1 ? "Docser" : `Docser #${index}`,
    description: "ドキュメント更新ワーカー",
    group: "Workers",
    kind: "worker" as const,
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: String(index), AGENT_ROLE: "docser" },
    }),
  })),
  {
    name: "db-up",
    label: "Database Start",
    description: "Postgres/Redisを起動",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "up", "-d", "postgres", "redis"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-down",
    label: "Database Stop",
    description: "Postgres/Redisを停止",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "down"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-push",
    label: "Database Push",
    description: "スキーマを反映",
    group: "Database",
    kind: "command",
    supportsStop: false,
    buildStart: async () => ({
      command: "pnpm",
      args: ["db:push"],
      cwd: resolveRepoRoot(),
    }),
  },
];

const processDefinitionMap = new Map(
  processDefinitions.map((definition) => [definition.name, definition])
);

function buildProcessInfo(
  definition: ProcessDefinition,
  runtime?: ProcessRuntime
): ProcessInfo {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    group: definition.group,
    kind: definition.kind,
    supportsStop: definition.supportsStop,
    status: runtime?.status ?? "idle",
    startedAt: runtime?.startedAt,
    finishedAt: runtime?.finishedAt,
    pid: runtime?.pid,
    exitCode: runtime?.exitCode,
    signal: runtime?.signal ? String(runtime.signal) : undefined,
    logPath: runtime?.logPath,
    message: runtime?.message,
    lastCommand: runtime?.lastCommand,
  };
}

function canAutoRestart(definition: ProcessDefinition, runtime: ProcessRuntime): boolean {
  if (!AUTO_RESTART_ENABLED) {
    return false;
  }
  if (!definition.autoRestart) {
    return false;
  }
  if (runtime.stopRequested) {
    return false;
  }
  return true;
}

async function scheduleProcessAutoRestart(
  definition: ProcessDefinition,
  runtime: ProcessRuntime
): Promise<void> {
  const now = Date.now();
  const windowMs = Number.isFinite(AUTO_RESTART_WINDOW_MS) && AUTO_RESTART_WINDOW_MS > 0
    ? AUTO_RESTART_WINDOW_MS
    : 300000;
  const maxAttempts = Number.isFinite(AUTO_RESTART_MAX_ATTEMPTS) && AUTO_RESTART_MAX_ATTEMPTS > 0
    ? AUTO_RESTART_MAX_ATTEMPTS
    : 5;
  const delayMs = Number.isFinite(AUTO_RESTART_DELAY_MS) && AUTO_RESTART_DELAY_MS >= 0
    ? AUTO_RESTART_DELAY_MS
    : 2000;

  const windowStart = runtime.restartWindowStartedAt ?? now;
  const resetWindow = now - windowStart > windowMs;
  const nextAttempts = (resetWindow ? 0 : (runtime.restartAttempts ?? 0)) + 1;
  const nextWindowStart = resetWindow ? now : windowStart;

  if (nextAttempts > maxAttempts) {
    managedProcesses.set(definition.name, {
      ...runtime,
      restartAttempts: nextAttempts,
      restartWindowStartedAt: nextWindowStart,
      restartScheduled: false,
      message: `Auto-restart exhausted (${maxAttempts}/${Math.round(windowMs / 1000)}s)`,
    });
    console.error(
      `[System] Auto-restart exhausted for ${definition.name} (attempts=${nextAttempts})`
    );
    return;
  }

  managedProcesses.set(definition.name, {
    ...runtime,
    restartAttempts: nextAttempts,
    restartWindowStartedAt: nextWindowStart,
    restartScheduled: true,
    message: `Auto-restart scheduled (${nextAttempts}/${maxAttempts})`,
  });

  setTimeout(async () => {
    const latest = managedProcesses.get(definition.name);
    if (!latest) {
      return;
    }
    if (latest.stopRequested || latest.status === "running") {
      managedProcesses.set(definition.name, {
        ...latest,
        restartScheduled: false,
      });
      return;
    }

    try {
      await startManagedProcess(definition, latest.lastPayload ?? {});
      const refreshed = managedProcesses.get(definition.name);
      if (refreshed) {
        managedProcesses.set(definition.name, {
          ...refreshed,
          restartScheduled: false,
          message: `Auto-restarted (${nextAttempts}/${maxAttempts})`,
        });
      }
      console.log(`[System] Auto-restarted process: ${definition.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = managedProcesses.get(definition.name);
      if (updated) {
        managedProcesses.set(definition.name, {
          ...updated,
          restartScheduled: false,
          message: `Auto-restart failed: ${message}`,
        });
      }
      console.error(`[System] Auto-restart failed for ${definition.name}: ${message}`);
    }
  }, delayMs);
}

async function startManagedProcess(
  definition: ProcessDefinition,
  payload: StartPayload
): Promise<ProcessInfo> {
  const existing = managedProcesses.get(definition.name);
  if (existing?.status === "running") {
    return buildProcessInfo(definition, existing);
  }

  const configRow = await ensureConfigRow();
  const configEnv = configToEnv(configRow);
  const command = await definition.buildStart(payload);
  const startedAt = new Date().toISOString();
  const logDir = resolveLogDir();
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `system-${definition.name}-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const child = spawn(command.command, command.args, {
    cwd: command.cwd ?? resolveRepoRoot(),
    env: {
      ...process.env,
      ...configEnv,
      ...command.env,
      OPENTIGER_LOG_DIR: logDir,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ログをファイルに流し込んで追跡できるようにする
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  const runtime: ProcessRuntime = {
    status: "running",
    startedAt,
    pid: child.pid,
    logPath,
    lastCommand: describeCommand(command),
    process: child,
    stopRequested: false,
    lastPayload: payload,
    restartScheduled: false,
  };
  managedProcesses.set(definition.name, runtime);

  // プロセス終了時に状態を更新する
  child.on("exit", (code, signal) => {
    const latest = managedProcesses.get(definition.name);
    if (!latest) return;
    const status = latest.stopRequested
      ? "stopped"
      : code === 0
        ? "completed"
        : "failed";
    const nextRuntime: ProcessRuntime = {
      ...latest,
      status,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      process: null,
    };
    managedProcesses.set(definition.name, nextRuntime);
    logStream.end();

    if (canAutoRestart(definition, nextRuntime)) {
      void scheduleProcessAutoRestart(definition, nextRuntime);
    }
  });

  child.on("error", (error) => {
    const latest = managedProcesses.get(definition.name);
    if (!latest) return;
    const nextRuntime: ProcessRuntime = {
      ...latest,
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: error.message,
      process: null,
    };
    managedProcesses.set(definition.name, nextRuntime);
    logStream.end();

    if (canAutoRestart(definition, nextRuntime)) {
      void scheduleProcessAutoRestart(definition, nextRuntime);
    }
  });

  child.unref();
  return buildProcessInfo(definition, runtime);
}

function stopManagedProcess(
  definition: ProcessDefinition
): ProcessInfo {
  const runtime = managedProcesses.get(definition.name);
  if (!runtime) {
    return buildProcessInfo(definition, { status: "idle" });
  }
  if (runtime.status !== "running" || !runtime.process) {
    return buildProcessInfo(definition, runtime);
  }

  runtime.stopRequested = true;
  runtime.message = "停止要求済み";
  managedProcesses.set(definition.name, runtime);

  const processRef = runtime.process;
  const pid = runtime.pid ?? processRef.pid;

  function killRuntime(signal: NodeJS.Signals): void {
    if (!pid) {
      processRef.kill(signal);
      return;
    }

    // detachedで起動したプロセスは新しいプロセスグループになるため、
    // グループごと停止して pnpm/tsx 配下の子プロセスが残るのを避ける
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // フォールバックとして単体PIDを停止する
      }
    }

    try {
      process.kill(pid, signal);
    } catch {
      // 既に終了しているケースは無視する
    }
  }

  // 停止要求は先に反映し、終了はイベントで確定する
  killRuntime("SIGTERM");
  setTimeout(() => {
    killRuntime("SIGKILL");
  }, 5000);

  return buildProcessInfo(definition, runtime);
}

function startRestart(): RestartStatus {
  const startedAt = new Date().toISOString();
  const logDir = resolveLogDir();
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `system-restart-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const child = spawn("pnpm", ["run", "restart"], {
    cwd: resolveRepoRoot(),
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ログをファイルに流し込んで追跡できるようにする
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  restartProcess = child;
  restartStatus = {
    status: "running",
    startedAt,
    logPath,
  };

  child.on("exit", (code, signal) => {
    restartStatus = {
      ...restartStatus,
      status: code === 0 ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
    };
    restartProcess = null;
    logStream.end();
  });

  child.on("error", (error) => {
    restartStatus = {
      ...restartStatus,
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: error.message,
    };
    restartProcess = null;
    logStream.end();
  });

  child.unref();
  return restartStatus;
}

async function ensureConfigRow() {
  // migration履歴が崩れていても system 起動時に必要カラムを補完する
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_count" text DEFAULT '1' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_count" text DEFAULT '1' NOT NULL`
  );

  const existing = await db.select().from(configTable).limit(1);
  const current = existing[0];
  if (current) {
    return current;
  }
  const created = await db
    .insert(configTable)
    .values(buildConfigRecord(DEFAULT_CONFIG, { includeDefaults: true }))
    .returning();
  const row = created[0];
  if (!row) {
    throw new Error("Failed to create config");
  }
  return row;
}

systemRoute.get("/restart", (c) => {
  return c.json(restartStatus);
});

systemRoute.post("/restart", (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  if (restartProcess) {
    return c.json(
      {
        error: "Restart already running",
        status: restartStatus,
      },
      409,
    );
  }

  try {
    const status = startRestart();
    return c.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart";
    restartStatus = { status: "failed", message };
    restartProcess = null;
    return c.json({ error: message }, 500);
  }
});

systemRoute.get("/requirements", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const requirementPath = await resolveRequirementPath(
      c.req.query("path"),
      "requirement.md"
    );
    const content = await readRequirementFile(requirementPath);
    return c.json({ path: requirementPath, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load requirement";
    return c.json({ error: message }, 400);
  }
});

systemRoute.post("/github/repo", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const ownerInput = typeof rawBody?.owner === "string" ? rawBody.owner.trim() : "";
  const repoInput = typeof rawBody?.repo === "string" ? rawBody.repo.trim() : "";
  const description =
    typeof rawBody?.description === "string" ? rawBody.description.trim() : "";
  const isPrivate = typeof rawBody?.private === "boolean" ? rawBody.private : true;

  const configRow = await ensureConfigRow();
  const owner = ownerInput || configRow.githubOwner;
  const repo = repoInput || configRow.githubRepo;
  const token = configRow.githubToken?.trim();

  if (!token) {
    return c.json({ error: "GitHub token is not configured" }, 400);
  }
  if (!owner) {
    return c.json({ error: "GitHub owner is required" }, 400);
  }
  if (!repo) {
    return c.json({ error: "GitHub repo is required" }, 400);
  }

  try {
    const info = await createRepo({
      token,
      owner,
      name: repo,
      description,
      private: isPrivate,
    });
    // 作成後の設定はDBに保存してUIの状態を合わせる
    await db
      .update(configTable)
      .set({
        githubOwner: owner,
        githubRepo: repo,
        repoUrl: info.url,
        updatedAt: new Date(),
      })
      .where(eq(configTable.id, configRow.id));

    return c.json({ repo: info });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
    const message = error instanceof Error ? error.message : "Failed to create repo";
    // 権限不足はUIに理由を返して設定を促す
    if (status === 403 && message.includes("Resource not accessible")) {
      return c.json(
        {
          error:
            "GitHub token lacks permission to create repositories. " +
            "Ensure the token has repo permissions and org access if needed.",
        },
        403
      );
    }
    return c.json({ error: message }, status === 403 ? 403 : 500);
  }
});

systemRoute.post("/preflight", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const content = typeof rawBody?.content === "string" ? rawBody.content : "";
    const autoCreateIssueTasks =
      typeof rawBody?.autoCreateIssueTasks === "boolean"
        ? rawBody.autoCreateIssueTasks
        : true;
    const hasRequirementContent = content.trim().length > 0;

    const configRow = await ensureConfigRow();
    const preflight = await buildPreflightSummary({
      configRow,
      autoCreateIssueTasks,
      autoCreatePrJudgeTasks: true,
    });

    const dispatcherEnabled = parseBooleanSetting(configRow.dispatcherEnabled, true);
    const judgeEnabled = parseBooleanSetting(configRow.judgeEnabled, true);
    const cycleManagerEnabled = parseBooleanSetting(configRow.cycleManagerEnabled, true);
    const workerCount = parseCountSetting(configRow.workerCount, 1);
    const testerCount = parseCountSetting(configRow.testerCount, 1);
    const docserCount = parseCountSetting(configRow.docserCount, 1);
    const judgeCount = parseCountSetting(configRow.judgeCount, 1);
    const plannerCount = parseCountSetting(configRow.plannerCount, 1);

    const hasIssueBacklog = preflight.github.issueTaskBacklogCount > 0;
    const hasLocalTaskBacklog =
      preflight.local.queuedTaskCount > 0
      || preflight.local.runningTaskCount > 0
      || preflight.local.failedTaskCount > 0
      || preflight.local.blockedTaskCount > 0;
    const hasJudgeBacklog =
      preflight.github.openPrCount > 0 || preflight.local.pendingJudgeTaskCount > 0;

    const startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog;
    const startExecutionAgents = startPlanner || hasIssueBacklog || hasLocalTaskBacklog;

    const recommendations = {
      startPlanner,
      startDispatcher: dispatcherEnabled && startExecutionAgents,
      // 実行系エージェントが動くサイクルではJudgeを常駐させる。
      startJudge: judgeEnabled && (hasJudgeBacklog || startExecutionAgents),
      plannerCount: startPlanner ? plannerCount : 0,
      judgeCount:
        judgeEnabled && (hasJudgeBacklog || startExecutionAgents)
          ? judgeCount
          : 0,
      startCycleManager:
        cycleManagerEnabled
        && (startExecutionAgents || hasJudgeBacklog || preflight.local.blockedTaskCount > 0),
      workerCount: startExecutionAgents ? workerCount : 0,
      testerCount: startExecutionAgents ? testerCount : 0,
      docserCount: startExecutionAgents ? docserCount : 0,
      reasons: [
        hasIssueBacklog
          ? `Issue backlog detected (${preflight.github.issueTaskBacklogCount})`
          : "No issue backlog",
        hasJudgeBacklog
          ? `Judge backlog detected (openPR=${preflight.github.openPrCount}, awaitingJudge=${preflight.local.pendingJudgeTaskCount})`
          : "No judge backlog",
        startPlanner
          ? "Planner is enabled because requirement content is present and issue/PR backlog is empty"
          : "Planner is skipped for this launch",
      ],
    };

    return c.json({
      preflight,
      recommendations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run preflight";
    return c.json({ error: message }, 500);
  }
});

systemRoute.get("/processes", (c) => {
  const processes = processDefinitions.map((definition) =>
    buildProcessInfo(definition, managedProcesses.get(definition.name))
  );
  return c.json({ processes });
});

systemRoute.get("/processes/:name", (c) => {
  const name = c.req.param("name");
  const definition = processDefinitionMap.get(name);
  if (!definition) {
    return c.json({ error: "Process not found" }, 404);
  }
  const info = buildProcessInfo(definition, managedProcesses.get(name));
  return c.json({ process: info });
});

systemRoute.post("/processes/:name/start", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const name = c.req.param("name");
  const definition = processDefinitionMap.get(name);
  if (!definition) {
    return c.json({ error: "Process not found" }, 404);
  }

  const existing = managedProcesses.get(name);
  const shouldRejectDuplicateStart = definition.kind === "planner";
  if (shouldRejectDuplicateStart) {
    // Plannerは重複起動すると同一要件から複数回計画が保存されやすいので、起動要求を排他する
    if (existing?.status === "running") {
      return c.json(
        {
          error: "Planner already running",
          process: buildProcessInfo(definition, existing),
        },
        409
      );
    }
    if (processStartLocks.has(name)) {
      return c.json(
        {
          error: "Planner start already in progress",
          process: buildProcessInfo(definition, managedProcesses.get(name)),
        },
        409
      );
    }
    processStartLocks.add(name);
  } else if (existing?.status === "running") {
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
          409
        );
      }
    }
    const payload: StartPayload = {
      requirementPath:
        typeof rawBody?.requirementPath === "string"
          ? rawBody.requirementPath
          : undefined,
      content: rawContent,
    };
    const processInfo = await startManagedProcess(definition, payload);
    return c.json({ process: processInfo });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start process";
    return c.json({ error: message }, 400);
  } finally {
    if (shouldRejectDuplicateStart) {
      processStartLocks.delete(name);
    }
  }
});

systemRoute.post("/processes/:name/stop", (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const name = c.req.param("name");
  const definition = processDefinitionMap.get(name);
  if (!definition) {
    return c.json({ error: "Process not found" }, 404);
  }

  if (!definition.supportsStop) {
    return c.json({ error: "Process cannot be stopped" }, 400);
  }

  const info = stopManagedProcess(definition);
  return c.json({ process: info });
});

systemRoute.post("/processes/stop-all", (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const stopped: string[] = [];
  const skipped: string[] = [];

  for (const definition of processDefinitions) {
    // uiとserver以外のプロセスのみ停止対象とする
    // uiとserverはpnpm run upで起動されるプロセスで、system.tsでは管理されていない
    if (definition.name === "ui" || definition.name === "server" || definition.name === "dashboard" || definition.name === "api") {
      continue;
    }

    if (!definition.supportsStop) {
      skipped.push(definition.name);
      continue;
    }

    const runtime = managedProcesses.get(definition.name);
    if (runtime?.status === "running" && runtime.process) {
      stopManagedProcess(definition);
      stopped.push(definition.name);
    } else {
      skipped.push(definition.name);
    }
  }

  return c.json({
    stopped,
    skipped,
    message: `Stopped ${stopped.length} process(es)`,
  });
});

systemRoute.post("/cleanup", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    // Redisのキューを全削除してジョブの残骸を消す
    const queuesCleaned = await obliterateAllQueues();
    console.log(`[Cleanup] Obliterated ${queuesCleaned} queues`);

    // 稼働中のプロセスがあってもDBのみをリセットできるようにする
    await db.execute(sql`
      UPDATE agents
      SET current_task_id = NULL,
          status = 'idle',
          last_heartbeat = NOW()
    `);
    await db.execute(sql`
      TRUNCATE artifacts, runs, leases, events, cycles, tasks RESTART IDENTITY
      CASCADE
    `);
    return c.json({ cleaned: true, queuesObliterated: queuesCleaned });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
    return c.json({ error: message }, 500);
  }
});

export { systemRoute };
