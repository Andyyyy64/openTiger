import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@sebastian-code/db";
import { events, tasks } from "@sebastian-code/db/schema";
import { and, eq } from "drizzle-orm";
import { getLocalDiffStats, getPRDiffStats } from "./evaluators/index.js";

const DOCSER_ALLOWED_PATHS = ["docs/**", "ops/runbooks/**", "README.md"];
const DOCSER_PATH_PREFIXES = ["docs/", "ops/runbooks/"];

type DocserSourceBase = {
  taskId: string;
  runId: string;
  agentId: string;
  workdir?: string;
};

type DocserSourcePR = DocserSourceBase & {
  mode: "git";
  prNumber: number;
};

type DocserSourceLocal = DocserSourceBase & {
  mode: "local";
  worktreePath: string;
  baseBranch: string;
  branchName: string;
  baseRepoPath?: string;
};

type DocserCreationResult = {
  created: boolean;
  reason?: string;
  docserTaskId?: string;
};

function isDocPath(path: string): boolean {
  if (path === "README.md") {
    return true;
  }
  return DOCSER_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasDocserTaskEvent(taskId: string): Promise<boolean> {
  // 同一タスクからの重複生成を防ぐ
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.type, "docser.task_created"), eq(events.entityId, taskId)))
    .limit(1);
  return existing.length > 0;
}

async function resolvePackageManager(workdir: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await pathExists(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(workdir, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

async function readRootScripts(
  workdir: string
): Promise<{ hasCheck: boolean; hasDev: boolean }> {
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      hasCheck: typeof parsed?.scripts?.check === "string",
      hasDev: typeof parsed?.scripts?.dev === "string",
    };
  } catch {
    return { hasCheck: false, hasDev: false };
  }
}

function buildScriptCommand(
  manager: "pnpm" | "yarn" | "npm",
  script: "check" | "dev"
): string {
  if (manager === "yarn") {
    return `yarn ${script}`;
  }
  if (manager === "pnpm") {
    return `pnpm run ${script}`;
  }
  return `npm run ${script}`;
}

async function resolveDocserCommands(
  workdir: string | undefined,
  fallback: string[]
): Promise<string[]> {
  if (!workdir) {
    return fallback;
  }

  const { hasCheck, hasDev } = await readRootScripts(workdir);
  const manager = await resolvePackageManager(workdir);
  const commands: string[] = [];

  if (hasCheck) {
    commands.push(buildScriptCommand(manager, "check"));
  }
  if (hasDev) {
    commands.push(buildScriptCommand(manager, "dev"));
  }

  return commands.length > 0 ? commands : fallback;
}

function summarizeFiles(files: string[], limit = 20): string {
  if (files.length <= limit) {
    return files.join("\n");
  }
  const head = files.slice(0, limit).join("\n");
  return `${head}\n... (${files.length - limit} more)`;
}

async function createDocserTask(params: {
  source: DocserSourcePR | DocserSourceLocal;
  diffFiles: string[];
  repoPathForScripts?: string;
}): Promise<DocserCreationResult> {
  const sourceTask = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, params.source.taskId));

  const baseTask = sourceTask[0];
  if (!baseTask) {
    return { created: false, reason: "source_task_missing" };
  }

  if (baseTask.role === "docser") {
    return { created: false, reason: "source_is_docser" };
  }

  if (await hasDocserTaskEvent(params.source.taskId)) {
    return { created: false, reason: "already_created" };
  }

  const docFiles = params.diffFiles.filter((file) => isDocPath(file));
  const nonDocFiles = params.diffFiles.filter((file) => !isDocPath(file));

  if (nonDocFiles.length === 0) {
    return { created: false, reason: "docs_only_change" };
  }

  // 既にドキュメントが更新されている場合はdocserを起こさない
  if (docFiles.length > 0) {
    return { created: false, reason: "docs_already_updated" };
  }

  const fallbackCommands =
    baseTask.commands && baseTask.commands.length > 0
      ? baseTask.commands
      : ["npm run check"];
  const commands = await resolveDocserCommands(
    params.repoPathForScripts,
    fallbackCommands
  );

  const notes = [
    `sourceTaskId: ${params.source.taskId}`,
    `sourceRunId: ${params.source.runId}`,
    `sourceMode: ${params.source.mode}`,
    params.source.mode === "git"
      ? `prNumber: ${params.source.prNumber}`
      : `worktreePath: ${params.source.worktreePath}`,
    "",
    "changedFiles:",
    summarizeFiles(params.diffFiles),
  ].join("\n");

  const [docserTask] = await db
    .insert(tasks)
    .values({
      title: `ドキュメント更新: ${baseTask.title}`,
      goal: "ドキュメントが実装と一致し、検証コマンドが成功する",
      context: {
        notes,
      },
      allowedPaths: DOCSER_ALLOWED_PATHS,
      commands,
      priority: baseTask.priority ?? 0,
      riskLevel: "low",
      role: "docser",
      dependencies: [params.source.taskId],
      timeboxMinutes: 45,
    })
    .returning({ id: tasks.id });

  if (!docserTask) {
    return { created: false, reason: "docser_task_insert_failed" };
  }

  await db.insert(events).values({
    type: "docser.task_created",
    entityType: "task",
    entityId: params.source.taskId,
    agentId: params.source.agentId,
    payload: {
      docserTaskId: docserTask.id,
      sourceTaskId: params.source.taskId,
      sourceRunId: params.source.runId,
      sourceMode: params.source.mode,
      sourceDetails:
        params.source.mode === "git"
          ? { prNumber: params.source.prNumber }
          : {
              worktreePath: params.source.worktreePath,
              baseBranch: params.source.baseBranch,
              branchName: params.source.branchName,
            },
      changedFiles: params.diffFiles,
    },
  });

  return { created: true, docserTaskId: docserTask.id };
}

export async function createDocserTaskForPR(
  params: DocserSourcePR
): Promise<DocserCreationResult> {
  const diffStats = await getPRDiffStats(params.prNumber);
  const diffFiles = diffStats.files.map((file) => file.filename);

  return createDocserTask({
    source: params,
    diffFiles,
    repoPathForScripts: params.workdir,
  });
}

export async function createDocserTaskForLocal(
  params: DocserSourceLocal
): Promise<DocserCreationResult> {
  const diffStats = await getLocalDiffStats(
    params.worktreePath,
    params.baseBranch,
    params.branchName
  );
  const diffFiles = diffStats.files.map((file) => file.filename);

  return createDocserTask({
    source: params,
    diffFiles,
    repoPathForScripts: params.baseRepoPath ?? params.workdir,
  });
}
