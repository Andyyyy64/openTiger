import { spawn } from "node:child_process";
import { parseIntegerEnvValue, readRuntimeEnv } from "../opencode/opencode-env";
import { buildOpenCodePrompt } from "../opencode/opencode-prompt";
import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";
import {
  CLAUDE_CODE_DEFAULT_MAX_TURNS,
  CLAUDE_CODE_DEFAULT_PERMISSION_MODE,
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_STREAM_FORMAT,
} from "./claude-code-constants";
import { normalizeClaudeModel, parseCsvSetting } from "./claude-code-helpers";
import { parseClaudeCodeStreamJson } from "./parse";

const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "delegate",
  "dontAsk",
  "plan",
]);

function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolvePermissionMode(options: OpenCodeOptions): string {
  const raw =
    readRuntimeEnv(options, "CLAUDE_CODE_PERMISSION_MODE") ?? CLAUDE_CODE_DEFAULT_PERMISSION_MODE;
  return CLAUDE_PERMISSION_MODES.has(raw) ? raw : CLAUDE_CODE_DEFAULT_PERMISSION_MODE;
}

function resolveClaudeModel(options: OpenCodeOptions): string {
  const configured = normalizeClaudeModel(readRuntimeEnv(options, "CLAUDE_CODE_MODEL"));
  if (configured) {
    return configured;
  }
  return normalizeClaudeModel(options.model) ?? CLAUDE_CODE_DEFAULT_MODEL;
}

function resolveEchoStdout(options: OpenCodeOptions): boolean {
  const fromRuntime = readRuntimeEnv(options, "CLAUDE_CODE_ECHO_STDOUT");
  return parseBooleanFlag(fromRuntime, true);
}

function extractAssistantTextFromEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant") {
    return "";
  }
  const message = record.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") {
      const normalized = text.trim();
      if (normalized.length > 0) {
        chunks.push(normalized);
      }
    }
  }
  return chunks.join("\n").trim();
}

export async function executeClaudeCodeOnce(
  options: OpenCodeOptions,
): Promise<Omit<OpenCodeResult, "retryCount">> {
  const startTime = Date.now();
  const echoStdout = resolveEchoStdout(options);
  const prompt = await buildOpenCodePrompt(options);
  const model = resolveClaudeModel(options);
  const permissionMode = resolvePermissionMode(options);
  const maxTurns = parseIntegerEnvValue(
    readRuntimeEnv(options, "CLAUDE_CODE_MAX_TURNS"),
    CLAUDE_CODE_DEFAULT_MAX_TURNS,
  );
  const allowedTools = parseCsvSetting(readRuntimeEnv(options, "CLAUDE_CODE_ALLOWED_TOOLS"));
  const disallowedTools = parseCsvSetting(readRuntimeEnv(options, "CLAUDE_CODE_DISALLOWED_TOOLS"));
  const appendSystemPrompt = readRuntimeEnv(options, "CLAUDE_CODE_APPEND_SYSTEM_PROMPT");

  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    CLAUDE_CODE_STREAM_FORMAT,
    "--verbose",
    "--permission-mode",
    permissionMode,
    "--model",
    model,
  ];
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  if (maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }
  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  if (disallowedTools.length > 0) {
    args.push("--disallowedTools", disallowedTools.join(","));
  }
  if (appendSystemPrompt && appendSystemPrompt.trim().length > 0) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  const baseEnv = options.inheritEnv === false ? {} : globalThis.process.env;
  const useProcessGroup = process.platform !== "win32";
  const childProcess = spawn("claude", args, {
    cwd: options.workdir,
    env: {
      ...baseEnv,
      ...options.env,
    },
    detached: useProcessGroup,
    stdio: ["ignore", "pipe", "pipe"],
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
        // fallback below
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already terminated
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
  let lastPrintedAssistantText = "";

  const flushStreamLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (echoStdout) {
        process.stdout.write(`${line}\n`);
      }
      return;
    }

    const assistantText = extractAssistantTextFromEvent(parsed);
    if (assistantText && assistantText !== lastPrintedAssistantText) {
      if (
        lastPrintedAssistantText &&
        assistantText.length > lastPrintedAssistantText.length &&
        assistantText.startsWith(lastPrintedAssistantText)
      ) {
        const delta = assistantText.slice(lastPrintedAssistantText.length).trimStart();
        if (delta.length > 0) {
          if (echoStdout) {
            process.stdout.write(`${delta}\n`);
          }
        }
      } else {
        if (echoStdout) {
          process.stdout.write(`${assistantText}\n`);
        }
      }
      lastPrintedAssistantText = assistantText;
    }
  };

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
      flushStreamLine(line);
    }
  });

  childProcess.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    process.stderr.write(chunk);
  });

  return new Promise((resolve) => {
    childProcess.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (streamBuffer.length > 0) {
        flushStreamLine(streamBuffer);
        streamBuffer = "";
      }
      const durationMs = Date.now() - startTime;
      if (signal) {
        stderr += `\n[ClaudeCode] Process exited by signal: ${signal}`;
      }
      if (timedOut) {
        stderr += "\n[ClaudeCode] Timeout exceeded";
      }

      const parsed = parseClaudeCodeStreamJson(stdout);
      const stdoutText = parsed.assistantText || parsed.resultText || stdout;
      const stderrParts = [...parsed.errors];
      if (parsed.permissionDenials.length > 0) {
        stderrParts.push(
          `Permission denied for tools: ${Array.from(new Set(parsed.permissionDenials)).join(", ")}`,
        );
      }
      if (parsed.isError && parsed.resultText) {
        stderrParts.push(parsed.resultText);
      }
      if (stderr.trim().length > 0) {
        stderrParts.push(stderr.trim());
      }
      const stderrText = stderrParts.join("\n").trim();
      const success = !parsed.isError && parsed.permissionDenials.length === 0 && (code ?? 1) === 0;

      resolve({
        success,
        exitCode: success ? 0 : (code ?? -1),
        stdout: stdoutText,
        stderr: stderrText || (success ? "" : "Claude Code execution failed"),
        durationMs,
        tokenUsage: parsed.tokenUsage
          ? {
              inputTokens: parsed.tokenUsage.inputTokens,
              outputTokens: parsed.tokenUsage.outputTokens,
              totalTokens: parsed.tokenUsage.totalTokens,
              cacheReadTokens: parsed.tokenUsage.cacheReadTokens,
              cacheWriteTokens: parsed.tokenUsage.cacheWriteTokens,
            }
          : undefined,
      });
    });

    childProcess.on("error", (error) => {
      clearTimeout(timeout);
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
