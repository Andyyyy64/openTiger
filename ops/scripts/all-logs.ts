import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

interface LogEntry {
  timestampMs: number;
  hasExplicitTimestamp: boolean;
  file: string;
  lineNo: number;
  line: string;
}

function parseArgs(argv: string[]): {
  sinceMinutes?: number;
  limit?: number;
  rootDir: string;
} {
  let sinceMinutes: number | undefined;
  let limit: number | undefined;
  let rootDir = "raw-logs";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since-minutes") {
      const raw = argv[i + 1];
      const value = Number.parseInt(raw ?? "", 10);
      if (Number.isFinite(value) && value >= 0) {
        sinceMinutes = value;
      }
      i++;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      const value = Number.parseInt(raw ?? "", 10);
      if (Number.isFinite(value) && value >= 0) {
        limit = value;
      }
      i++;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value) {
        rootDir = value;
      }
      i++;
      continue;
    }
  }

  return { sinceMinutes, limit, rootDir };
}

async function collectLogFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

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
  return files.sort();
}

function extractTimestampMs(line: string): number | undefined {
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

async function buildEntries(files: string[]): Promise<LogEntry[]> {
  const allEntries: LogEntry[] = [];

  for (const file of files) {
    const [content, fileStat] = await Promise.all([
      readFile(file, "utf-8").catch(() => ""),
      stat(file),
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

      const parsed = extractTimestampMs(line);
      const timestampMs = parsed ?? fileStat.mtimeMs + index / 1_000_000;

      allEntries.push({
        timestampMs,
        hasExplicitTimestamp: parsed !== undefined,
        file,
        lineNo: index + 1,
        line,
      });
    }
  }

  return allEntries;
}

function formatEntry(entry: LogEntry, cwd: string): string {
  const prefix = entry.hasExplicitTimestamp
    ? new Date(entry.timestampMs).toISOString()
    : `~${new Date(entry.timestampMs).toISOString()}`;
  const source = relative(cwd, entry.file);
  return `[${prefix}] ${source}:${entry.lineNo} | ${entry.line}`;
}

async function main(): Promise<void> {
  const { sinceMinutes, limit, rootDir } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const resolvedRoot = resolve(cwd, rootDir);
  const files = await collectLogFiles(resolvedRoot);

  if (files.length === 0) {
    console.log(`No log files found under ${resolvedRoot}`);
    return;
  }

  let entries = await buildEntries(files);

  if (sinceMinutes !== undefined) {
    const threshold = Date.now() - sinceMinutes * 60_000;
    entries = entries.filter((entry) => entry.timestampMs >= threshold);
  }

  entries.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.lineNo - b.lineNo;
  });

  if (limit !== undefined && entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }

  for (const entry of entries) {
    console.log(formatEntry(entry, cwd));
  }
}

void main();
