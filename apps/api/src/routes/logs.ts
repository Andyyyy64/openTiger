import { Hono } from "hono";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const logsRoute = new Hono();

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

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
  if (process.env.H1VE_LOG_DIR) {
    return process.env.H1VE_LOG_DIR;
  }
  if (process.env.H1VE_RAW_LOG_DIR) {
    return process.env.H1VE_RAW_LOG_DIR;
  }
  // APIの作業ディレクトリに依存せず、リポジトリ直下を基準にする
  return join(resolve(import.meta.dirname, "../../../.."), "raw-logs");
}

async function readTailLines(
  filePath: string,
  lineLimit: number
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

    // 末尾から読むと最初の行が途中で切れることがあるため補正する
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
  const logPath = join(logDir, `${agentId}.log`);

  try {
    const { log, sizeBytes, updatedAt } = await readTailLines(logPath, lines);
    return c.json({ log, sizeBytes, updatedAt, path: logPath });
  } catch (error) {
    console.warn("[Logs] Failed to read agent log:", error);
    return c.json({ error: "Log not found" }, 404);
  }
});
