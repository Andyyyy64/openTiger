import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@sebastian-code/db";
import { config as configTable } from "@sebastian-code/db/schema";
import { configToEnv, DEFAULT_CONFIG, buildConfigRecord } from "../system-config.js";
import { getAuthInfo } from "../middleware/index.js";
import { createRepo } from "@sebastian-code/vcs";

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
  buildStart: (payload: StartPayload) => Promise<StartCommand>;
};

const systemRoute = new Hono();

let restartProcess: ChildProcess | null = null;
let restartStatus: RestartStatus = { status: "idle" };
const managedProcesses = new Map<string, ProcessRuntime>();

function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

function resolveLogDir(): string {
  if (process.env.SEBASTIAN_LOG_DIR) {
    return process.env.SEBASTIAN_LOG_DIR;
  }
  if (process.env.SEBASTIAN_RAW_LOG_DIR) {
    return process.env.SEBASTIAN_RAW_LOG_DIR;
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
  return process.env.SEBASTIAN_ALLOW_INSECURE_SYSTEM_CONTROL === "true";
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

const processDefinitions: ProcessDefinition[] = [
  {
    name: "planner",
    label: "Planner",
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
        args: ["--filter", "@sebastian-code/planner", "dev", requirementPath],
        cwd: resolveRepoRoot(),
      };
    },
  },
  {
    name: "dispatcher",
    label: "Dispatcher",
    description: "タスク割当の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/dispatcher", "dev"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "judge",
    label: "Judge",
    description: "レビュー判定の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/judge", "dev"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "cycle-manager",
    label: "Cycle Manager",
    description: "長時間運用の管理プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/cycle-manager", "dev"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "worker-1",
    label: "Worker #1",
    description: "実装ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "1", AGENT_ROLE: "worker" },
    }),
  },
  {
    name: "worker-2",
    label: "Worker #2",
    description: "実装ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "2", AGENT_ROLE: "worker" },
    }),
  },
  {
    name: "worker-3",
    label: "Worker #3",
    description: "実装ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "3", AGENT_ROLE: "worker" },
    }),
  },
  {
    name: "worker-4",
    label: "Worker #4",
    description: "実装ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "4", AGENT_ROLE: "worker" },
    }),
  },
  {
    name: "tester-1",
    label: "Tester #1",
    description: "テスト専用ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "1", AGENT_ROLE: "tester" },
    }),
  },
  {
    name: "tester-2",
    label: "Tester #2",
    description: "テスト専用ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "2", AGENT_ROLE: "tester" },
    }),
  },
  {
    name: "docser-1",
    label: "Docser",
    description: "ドキュメント更新ワーカー",
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@sebastian-code/worker", "dev:runtime"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: "1", AGENT_ROLE: "docser" },
    }),
  },
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
    env: { ...process.env, ...configEnv, ...command.env },
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
    managedProcesses.set(definition.name, {
      ...latest,
      status,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      process: null,
    });
    logStream.end();
  });

  child.on("error", (error) => {
    const latest = managedProcesses.get(definition.name);
    if (!latest) return;
    managedProcesses.set(definition.name, {
      ...latest,
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: error.message,
      process: null,
    });
    logStream.end();
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

  // 停止要求は先に反映し、終了はイベントで確定する
  runtime.process.kill("SIGTERM");
  setTimeout(() => {
    if (runtime.process && !runtime.process.killed) {
      runtime.process.kill("SIGKILL");
    }
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
  if (existing?.status === "running") {
    return c.json({
      process: buildProcessInfo(definition, existing),
      alreadyRunning: true,
    });
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const rawContent = typeof rawBody?.content === "string" ? rawBody.content : undefined;
  if (rawContent !== undefined && rawContent.trim().length === 0) {
    return c.json({ error: "Requirement content is empty" }, 400);
  }
  const payload: StartPayload = {
    requirementPath:
      typeof rawBody?.requirementPath === "string"
        ? rawBody.requirementPath
        : undefined,
    content: rawContent,
  };

  try {
    const processInfo = await startManagedProcess(definition, payload);
    return c.json({ process: processInfo });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start process";
    return c.json({ error: message }, 400);
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
    return c.json({ cleaned: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
    return c.json({ error: message }, 500);
  }
});

export { systemRoute };
