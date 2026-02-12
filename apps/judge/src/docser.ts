import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@openTiger/db";
import { events, tasks } from "@openTiger/db/schema";
import { and, eq } from "drizzle-orm";
import { getLocalDiffStats, getPRDiffStats } from "./evaluators/index";

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

function isAutoFixTaskTitle(title: string): boolean {
  return /^\[(?:AutoFix|AutoFix-Conflict)\]\s+PR\s+#\d+/i.test(title.trim());
}

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

type DocGapInfo = {
  docsMissing: boolean;
  docsEmpty: boolean;
  readmeMissing: boolean;
  docsReadmeMissing: boolean;
  hasGap: boolean;
};

async function detectDocGap(workdir?: string): Promise<DocGapInfo> {
  if (!workdir) {
    return {
      docsMissing: false,
      docsEmpty: false,
      readmeMissing: false,
      docsReadmeMissing: false,
      hasGap: false,
    };
  }

  const docsPath = join(workdir, "docs");
  const docsMissing = !(await pathExists(docsPath));
  const readmeMissing = !(await pathExists(join(workdir, "README.md")));
  const docsReadmeMissing = !(await pathExists(join(workdir, "docs", "README.md")));

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

async function hasDocserTaskEvent(taskId: string): Promise<boolean> {
  // Avoid duplicate creation from same task
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

async function readRootScripts(workdir: string): Promise<{ hasCheck: boolean; hasDev: boolean }> {
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

function buildScriptCommand(manager: "pnpm" | "yarn" | "npm", script: "check" | "dev"): string {
  if (manager === "yarn") {
    return `yarn ${script}`;
  }
  if (manager === "pnpm") {
    return `pnpm run ${script}`;
  }
  return `npm run ${script}`;
}

async function resolveDocserCommands(workdir: string | undefined): Promise<string[]> {
  if (!workdir) {
    return [];
  }

  const { hasCheck } = await readRootScripts(workdir);
  const manager = await resolvePackageManager(workdir);
  const commands: string[] = [];

  if (hasCheck) {
    commands.push(buildScriptCommand(manager, "check"));
  }

  return commands;
}

function hasUnsupportedShellOperator(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const prev = i > 0 ? command[i - 1] : "";
    const next = i + 1 < command.length ? command[i + 1] : "";

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote !== "'") {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "|" || char === ";" || char === "<" || char === ">" || char === "`") {
      return true;
    }
    if (char === "&" && prev !== "&" && next !== "&") {
      return true;
    }
  }

  return false;
}

function sanitizeDocserCommands(commands: string[]): string[] {
  const unique = new Set<string>();
  const sanitized: string[] = [];

  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || unique.has(trimmed) || hasUnsupportedShellOperator(trimmed)) {
      continue;
    }
    unique.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
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
  const sourceTask = await db.select().from(tasks).where(eq(tasks.id, params.source.taskId));

  const baseTask = sourceTask[0];
  if (!baseTask) {
    return { created: false, reason: "source_task_missing" };
  }

  if (baseTask.role === "docser") {
    return { created: false, reason: "source_is_docser" };
  }

  if (isAutoFixTaskTitle(baseTask.title)) {
    return { created: false, reason: "source_is_autofix" };
  }

  if (await hasDocserTaskEvent(params.source.taskId)) {
    return { created: false, reason: "already_created" };
  }

  const nonDocFiles = params.diffFiles.filter((file) => !isDocPath(file));
  const docGap = await detectDocGap(params.repoPathForScripts);

  // Start docser even when diff is docs-only if documentation is insufficient
  if (nonDocFiles.length === 0 && !docGap.hasGap) {
    return { created: false, reason: "docs_only_change" };
  }

  const fallbackCommands = sanitizeDocserCommands(baseTask.commands ?? []);
  if (fallbackCommands.length > 0) {
    console.log(
      `[Judge] Skipping inherited verification commands for docser task: ${fallbackCommands.join(", ")}`,
    );
  }
  const commands = await resolveDocserCommands(params.repoPathForScripts);

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
    "",
    "docGap:",
    JSON.stringify(docGap),
  ].join("\n");

  const [docserTask] = await db
    .insert(tasks)
    .values({
      title: `Documentation update: ${baseTask.title}`,
      goal: "Documentation matches implementation and verification commands pass",
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

export async function createDocserTaskForPR(params: DocserSourcePR): Promise<DocserCreationResult> {
  const diffStats = await getPRDiffStats(params.prNumber);
  const diffFiles = diffStats.files.map((file) => file.filename);

  return createDocserTask({
    source: params,
    diffFiles,
  });
}

export async function createDocserTaskForLocal(
  params: DocserSourceLocal & { diffFiles?: string[] },
): Promise<DocserCreationResult> {
  const diffFiles =
    params.diffFiles ??
    (await getLocalDiffStats(params.worktreePath, params.baseBranch, params.branchName)).files.map(
      (file) => file.filename,
    );

  return createDocserTask({
    source: params,
    diffFiles,
    repoPathForScripts: params.baseRepoPath,
  });
}
