import { spawn } from "node:child_process";
import { parseBooleanEnvValue, readRuntimeEnv } from "../opencode/opencode-env";
import { buildOpenCodePrompt } from "../opencode/opencode-prompt";
import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";
import { CODEX_DEFAULT_MODEL } from "./codex-constants";
import { isIgnorableCodexStderrLine, normalizeCodexModel } from "./codex-helpers";
import {
  extractCodexAssistantTextFromEventLine,
  parseCodexExecJson,
  type CodexExecParseResult,
} from "./parse";

function resolveCodexModel(options: OpenCodeOptions): string {
  const configured = normalizeCodexModel(readRuntimeEnv(options, "CODEX_MODEL"));
  if (configured) {
    return configured;
  }
  return normalizeCodexModel(options.model) ?? CODEX_DEFAULT_MODEL;
}

function resolveEchoStdout(options: OpenCodeOptions): boolean {
  const fromRuntime = readRuntimeEnv(options, "CODEX_ECHO_STDOUT");
  return parseBooleanEnvValue(fromRuntime, true);
}

function buildCodexExecArgs(model: string): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--full-auto",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--model",
    model,
    "-",
  ];
  return args;
}

function parseStreamResult(stdout: string): CodexExecParseResult {
  const parsed = parseCodexExecJson(stdout);
  if (!parsed.assistantText.trim()) {
    return {
      ...parsed,
      assistantText: stdout,
    };
  }
  return parsed;
}

export async function executeCodexOnce(
  options: OpenCodeOptions,
): Promise<Omit<OpenCodeResult, "retryCount">> {
  const startTime = Date.now();
  const prompt = await buildOpenCodePrompt(options);
  const model = resolveCodexModel(options);
  const echoStdout = resolveEchoStdout(options);
  const args = buildCodexExecArgs(model);

  const baseEnv = options.inheritEnv === false ? {} : globalThis.process.env;
  const mergedEnv = {
    ...baseEnv,
    ...options.env,
  };

  if (!mergedEnv.CODEX_API_KEY && mergedEnv.OPENAI_API_KEY) {
    mergedEnv.CODEX_API_KEY = mergedEnv.OPENAI_API_KEY;
  }

  const useProcessGroup = process.platform !== "win32";
  const childProcess = spawn("codex", args, {
    cwd: options.workdir,
    env: mergedEnv,
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const timeoutMs = options.timeoutSeconds * 1000;
  let timedOut = false;
  const terminate = (signal: NodeJS.Signals): void => {
    const pid = childProcess.pid;
    if (!pid) {
      try {
        childProcess.kill(signal);
      } catch {
        // Ignore if already terminated
      }
      return;
    }
    if (useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fallback to direct PID kill below.
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already terminated.
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    setTimeout(() => terminate("SIGKILL"), 2000);
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let streamBuffer = "";
  let stderrBuffer = "";

  childProcess.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    streamBuffer += chunk;

    while (true) {
      const newlineIndex = streamBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = streamBuffer.slice(0, newlineIndex);
      streamBuffer = streamBuffer.slice(newlineIndex + 1);

      const assistantText = extractCodexAssistantTextFromEventLine(line);
      if (assistantText && echoStdout) {
        process.stdout.write(`${assistantText}\n`);
      }
    }
  });

  const appendStderrLine = (line: string, hasNewline: boolean): void => {
    if (isIgnorableCodexStderrLine(line)) {
      return;
    }
    const text = hasNewline ? `${line}\n` : line;
    stderr += text;
    process.stderr.write(text);
  };

  childProcess.stderr.on("data", (data: Buffer) => {
    stderrBuffer += data.toString();
    while (true) {
      const newlineIndex = stderrBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = stderrBuffer.slice(0, newlineIndex);
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      appendStderrLine(line, true);
    }
  });

  childProcess.stdin.on("error", () => {
    // Ignore broken pipe when process exits early.
  });
  childProcess.stdin.write(prompt);
  childProcess.stdin.end();

  return new Promise((resolve) => {
    childProcess.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (stderrBuffer.length > 0) {
        appendStderrLine(stderrBuffer, false);
        stderrBuffer = "";
      }
      const durationMs = Date.now() - startTime;
      if (signal) {
        stderr += `\n[Codex] Process exited by signal: ${signal}`;
      }
      if (timedOut) {
        stderr += "\n[Codex] Timeout exceeded";
      }

      const parsed = parseStreamResult(stdout);
      const stderrParts = [...parsed.errors];
      if (stderr.trim().length > 0) {
        stderrParts.push(stderr.trim());
      }

      const success = !timedOut && !parsed.isError && (code ?? 1) === 0;
      resolve({
        success,
        exitCode: success ? 0 : (code ?? -1),
        stdout: parsed.assistantText,
        stderr: stderrParts.join("\n").trim() || (success ? "" : "Codex execution failed"),
        durationMs,
        tokenUsage: parsed.tokenUsage,
      });
    });

    childProcess.on("error", (error) => {
      clearTimeout(timeout);
      if (stderrBuffer.length > 0) {
        appendStderrLine(stderrBuffer, false);
        stderrBuffer = "";
      }
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        durationMs: Date.now() - startTime,
      });
    });
  });
}
