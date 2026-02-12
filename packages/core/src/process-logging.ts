import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProcessLoggingOptions {
  label?: string;
  logDir?: string;
}

export function setupProcessLogging(
  logName: string,
  options: ProcessLoggingOptions = {},
): string | undefined {
  const defaultLogDir = resolve(import.meta.dirname, "../../../raw-logs");
  const logDir = options.logDir ?? process.env.OPENTIGER_LOG_DIR ?? defaultLogDir;

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${logName}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });

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

  const label = options.label ?? "Process";
  console.log(`[Logger] ${label} logs are written to ${logPath}`);
  return logPath;
}
