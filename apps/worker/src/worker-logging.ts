import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const logStreams = new Set<ReturnType<typeof createWriteStream>>();
let taskLogStream: ReturnType<typeof createWriteStream> | null = null;
const LEGACY_LOG_DIR_PLACEHOLDER_MARKER = "/absolute/path/to/opentiger";

function resolveLogDir(fallbackDir: string): string {
  const candidate =
    process.env.OPENTIGER_LOG_DIR?.trim() || process.env.OPENTIGER_RAW_LOG_DIR?.trim();
  if (
    candidate &&
    !candidate.trim().replace(/\\/gu, "/").toLowerCase().includes(LEGACY_LOG_DIR_PLACEHOLDER_MARKER)
  ) {
    return resolve(candidate);
  }
  return resolve(fallbackDir);
}

export function setTaskLogPath(logPath?: string): void {
  // Switch log stream per task
  if (taskLogStream) {
    logStreams.delete(taskLogStream);
    taskLogStream.end();
    taskLogStream = null;
  }

  if (!logPath) {
    return;
  }

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create task log dir: ${logPath}`, error);
    return;
  }

  taskLogStream = createWriteStream(logPath, { flags: "a" });
  logStreams.add(taskLogStream);
  console.log(`[Logger] Task logs are written to ${logPath}`);
}

export function setupProcessLogging(agentId: string): string | undefined {
  const defaultLogDir = resolve(import.meta.dirname, "../../../raw-logs");
  const logDir = resolveLogDir(defaultLogDir);

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${agentId}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  logStreams.add(stream);

  // Write stdout/stderr to log as well
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    for (const target of logStreams) {
      target.write(chunk);
    }
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    for (const target of logStreams) {
      target.write(chunk);
    }
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;

  process.on("exit", () => {
    for (const target of logStreams) {
      target.end();
    }
  });

  console.log(`[Logger] Worker logs are written to ${logPath}`);
  return logPath;
}

export function buildTaskLogPath(
  logDir: string,
  taskId: string,
  runId: string,
  agentId: string,
): string {
  return join(logDir, "tasks", taskId, `${agentId}-${runId}.log`);
}
