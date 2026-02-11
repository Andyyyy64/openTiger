import { Hono } from "hono";
import { open, stat, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { getAuthInfo } from "../middleware/index";
import { canControlSystem } from "./system-auth";

export const logsRoute = new Hono();

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;
const DEFAULT_ALL_LIMIT = 2000;
const MAX_ALL_LIMIT = 20000;

function parseLines(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LINES;
  }
  return Math.min(parsed, MAX_LINES);
}

function sanitizeAgentId(agentId: string): string | null {
  const trimmed = agentId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveLogDir(): string {
  if (process.env.OPENTIGER_LOG_DIR) {
    return process.env.OPENTIGER_LOG_DIR;
  }
  if (process.env.OPENTIGER_RAW_LOG_DIR) {
    return process.env.OPENTIGER_RAW_LOG_DIR;
  }
  // Use repo root, independent of API working directory
  return join(resolve(import.meta.dirname, "../../../.."), "raw-logs");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function clearLogDir(logDir: string): Promise<{ removed: number; failed: number }> {
  if (!(await pathExists(logDir))) {
    return { removed: 0, failed: 0 };
  }

  const entries = await readdir(logDir, { withFileTypes: true });
  let removed = 0;
  let failed = 0;

  for (const entry of entries) {
    const fullPath = join(logDir, entry.name);
    try {
      await rm(fullPath, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      console.warn("[Logs] Failed to remove log entry:", fullPath, error);
    }
  }

  return { removed, failed };
}

function buildAgentNameAliases(agentId: string): string[] {
  const aliases = new Set<string>([agentId]);
  const hasExplicitIndex = /-\d+$/.test(agentId);
  if (hasExplicitIndex) {
    return Array.from(aliases);
  }
  const withoutIndex = agentId.replace(/-\d+$/, "");
  if (withoutIndex && withoutIndex !== agentId) {
    aliases.add(withoutIndex);
  }
  return Array.from(aliases);
}

function extractSystemLogTimestamp(fileName: string): number {
  const match = fileName.match(/-(\d+)\.log$/);
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

async function findLatestSystemLog(logDir: string, processNames: string[]): Promise<string | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(logDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter(
      (entry) =>
        entry.endsWith(".log") && processNames.some((name) => entry.startsWith(`system-${name}-`)),
    )
    .sort((a, b) => extractSystemLogTimestamp(b) - extractSystemLogTimestamp(a));

  const latest = candidates[0];
  if (!latest) {
    return null;
  }
  return join(logDir, latest);
}

async function findLatestTaskLog(logDir: string, agentAliases: string[]): Promise<string | null> {
  const taskLogRoot = join(logDir, "tasks");
  if (!(await pathExists(taskLogRoot))) {
    return null;
  }

  let taskLogFiles: string[] = [];
  try {
    taskLogFiles = await collectLogFiles(taskLogRoot);
  } catch {
    return null;
  }

  const aliasPrefixes = agentAliases.map((alias) => `${alias}-`);
  const candidateFiles = taskLogFiles.filter((filePath) => {
    const fileName = basename(filePath);
    return aliasPrefixes.some((prefix) => fileName.startsWith(prefix));
  });

  let latestPath: string | null = null;
  let latestMtimeMs = Number.NEGATIVE_INFINITY;
  for (const filePath of candidateFiles) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = fileStat.mtimeMs;
        latestPath = filePath;
      }
    } catch {
      continue;
    }
  }

  return latestPath;
}

async function resolveAgentLogPath(logDir: string, agentId: string): Promise<string | null> {
  const aliases = buildAgentNameAliases(agentId);

  for (const alias of aliases) {
    const direct = join(logDir, `${alias}.log`);
    if (await pathExists(direct)) {
      return direct;
    }
  }

  const latestSystemLog = await findLatestSystemLog(logDir, aliases);
  if (latestSystemLog) {
    return latestSystemLog;
  }

  return findLatestTaskLog(logDir, aliases);
}

function parseAllLimit(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ALL_LIMIT;
  }
  return Math.min(parsed, MAX_ALL_LIMIT);
}

function parseSinceMinutes(value: string | undefined): number | undefined {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseTimestampMs(line: string): number | undefined {
  const iso = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  if (iso?.[0]) {
    const ms = Date.parse(iso[0]);
    if (Number.isFinite(ms)) {
      return ms;
    }
  }

  const slash = line.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\b/);
  if (slash) {
    const [, y, m, d, hh, mm, ss] = slash;
    const ms = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss),
    ).getTime();
    if (Number.isFinite(ms)) {
      return ms;
    }
  }

  return undefined;
}

async function collectLogFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".log")) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

interface AllLogEntry {
  timestampMs: number;
  explicitTimestamp: boolean;
  source: string;
  lineNo: number;
  line: string;
}

async function readAllLogs(options: {
  logDir: string;
  limit: number;
  sinceMinutes?: number;
  sourceFilter?: string;
}): Promise<{
  entries: Array<{
    timestamp: string;
    explicitTimestamp: boolean;
    source: string;
    lineNo: number;
    line: string;
  }>;
  total: number;
  returned: number;
  truncated: boolean;
  sourceCount: number;
  generatedAt: string;
}> {
  const { logDir, limit, sinceMinutes, sourceFilter } = options;
  const files = await collectLogFiles(logDir);
  const loweredSource = sourceFilter?.trim().toLowerCase();
  const entries: AllLogEntry[] = [];

  for (const filePath of files) {
    const source = relative(logDir, filePath);
    if (loweredSource && !source.toLowerCase().includes(loweredSource)) {
      continue;
    }

    const [content, fileStat] = await Promise.all([
      readFile(filePath, "utf-8").catch(() => ""),
      stat(filePath),
    ]);
    if (!content) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.trim()) {
        continue;
      }
      const parsedTs = parseTimestampMs(line);
      const timestampMs = parsedTs ?? fileStat.mtimeMs + index / 1_000_000;
      entries.push({
        timestampMs,
        explicitTimestamp: parsedTs !== undefined,
        source,
        lineNo: index + 1,
        line,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }
    return a.lineNo - b.lineNo;
  });

  const threshold = sinceMinutes !== undefined ? Date.now() - sinceMinutes * 60_000 : undefined;
  const filtered =
    threshold !== undefined ? entries.filter((entry) => entry.timestampMs >= threshold) : entries;

  const total = filtered.length;
  const sliced = total > limit ? filtered.slice(total - limit) : filtered;
  const truncated = total > limit;

  return {
    entries: sliced.map((entry) => ({
      timestamp: new Date(entry.timestampMs).toISOString(),
      explicitTimestamp: entry.explicitTimestamp,
      source: entry.source,
      lineNo: entry.lineNo,
      line: entry.line,
    })),
    total,
    returned: sliced.length,
    truncated,
    sourceCount: files.length,
    generatedAt: new Date().toISOString(),
  };
}

async function readTailLines(
  filePath: string,
  lineLimit: number,
): Promise<{ log: string; sizeBytes: number; updatedAt: string }> {
  const fileStat = await stat(filePath);
  const sizeBytes = fileStat.size;
  const bytesToRead = Math.min(sizeBytes, MAX_BYTES);
  const startPosition = Math.max(sizeBytes - bytesToRead, 0);

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, startPosition);
    const chunk = buffer.toString("utf-8");

    // Correct for cases where reading from end may truncate the first line
    const lines = chunk.split(/\r?\n/);
    if (startPosition > 0) {
      lines.shift();
    }

    const tail = lines.slice(-lineLimit).join("\n");
    return {
      log: tail,
      sizeBytes,
      updatedAt: fileStat.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

logsRoute.get("/agents/:id", async (c) => {
  const rawId = c.req.param("id");
  const agentId = sanitizeAgentId(rawId);
  if (!agentId) {
    return c.json({ error: "Invalid agent id" }, 400);
  }

  const lines = parseLines(c.req.query("lines"));
  const logDir = resolveLogDir();
  const logPath = await resolveAgentLogPath(logDir, agentId);
  if (!logPath) {
    return c.json({ error: "Log not found" }, 404);
  }

  try {
    const { log, sizeBytes, updatedAt } = await readTailLines(logPath, lines);
    return c.json({ log, sizeBytes, updatedAt, path: logPath });
  } catch (error) {
    console.warn("[Logs] Failed to read agent log:", error);
    return c.json({ error: "Log not found" }, 404);
  }
});

logsRoute.get("/cycle-manager", async (c) => {
  const lines = parseLines(c.req.query("lines"));
  const logDir = resolveLogDir();
  const directPath = join(logDir, "cycle-manager.log");
  const logPath = (await pathExists(directPath))
    ? directPath
    : ((await findLatestSystemLog(logDir, ["cycle-manager"])) ?? directPath);

  try {
    const { log, sizeBytes, updatedAt } = await readTailLines(logPath, lines);
    return c.json({ log, sizeBytes, updatedAt, path: logPath });
  } catch (error) {
    console.warn("[Logs] Failed to read cycle-manager log:", error);
    return c.json({ error: "Log not found" }, 404);
  }
});

logsRoute.get("/all", async (c) => {
  const limit = parseAllLimit(c.req.query("limit"));
  const sinceMinutes = parseSinceMinutes(c.req.query("sinceMinutes"));
  const sourceFilter = c.req.query("source");
  const logDir = resolveLogDir();

  try {
    const result = await readAllLogs({
      logDir,
      limit,
      sinceMinutes,
      sourceFilter,
    });
    return c.json(result);
  } catch (error) {
    console.warn("[Logs] Failed to read aggregated logs:", error);
    return c.json({ error: "Failed to aggregate logs" }, 500);
  }
});

logsRoute.post("/clear", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const logDir = resolveLogDir();
  try {
    const { removed, failed } = await clearLogDir(logDir);
    return c.json({ cleared: true, removed, failed, logDir });
  } catch (error) {
    console.warn("[Logs] Failed to clear logs:", error);
    return c.json({ error: "Failed to clear logs" }, 500);
  }
});
