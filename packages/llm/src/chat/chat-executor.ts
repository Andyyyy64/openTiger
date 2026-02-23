import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { parseClaudeCodeStreamJson } from "../claude-code/parse";
import { parseCodexExecJson, extractCodexAssistantTextFromEventLine } from "../codex/parse";

export interface ChatExecutorOptions {
  executor: "claude_code" | "codex" | "opencode";
  model?: string;
  messages: { role: string; content: string }[];
  systemPrompt: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface ChatExecutorHandle {
  onChunk: (cb: (chunk: string) => void) => void;
  onDone: (cb: (result: { content: string; success: boolean }) => void) => void;
  abort: () => void;
}

function buildPromptFromMessages(
  systemPrompt: string,
  messages: { role: string; content: string }[],
): string {
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`[System]\n${systemPrompt}`);
  }
  for (const msg of messages) {
    const prefix = msg.role === "user" ? "[User]" : msg.role === "assistant" ? "[Assistant]" : "[System]";
    parts.push(`${prefix}\n${msg.content}`);
  }
  parts.push("[Assistant]");
  return parts.join("\n\n");
}

function spawnClaudeCode(
  prompt: string,
  model: string,
  workdir: string,
  env: Record<string, string>,
): ChildProcess {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
  return spawn("claude", args, {
    cwd: workdir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function spawnCodex(
  prompt: string,
  model: string,
  workdir: string,
  env: Record<string, string>,
): ChildProcess {
  const args = ["exec", "--json", "--full-auto", "--model", model, "-"];
  const child = spawn("codex", args, {
    cwd: workdir,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }
  return child;
}

function spawnOpencode(
  prompt: string,
  model: string,
  workdir: string,
  env: Record<string, string>,
): ChildProcess {
  const promptDir = join(tmpdir(), "opentiger-chat");
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `chat-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, "utf-8");

  const args = ["run", "--model", model, "--file", promptFile];
  return spawn("opencode", args, {
    cwd: workdir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Extract assistant text from a Claude CLI stream-json line.
 * Claude CLI `assistant` events contain CUMULATIVE text (the full response so far),
 * NOT incremental deltas. The caller must track previous text to compute deltas.
 */
function extractAssistantTextFromStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const event = JSON.parse(trimmed);
    // `assistant` events contain cumulative message content
    if (event?.type === "assistant" && event?.message?.content) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (item: { type?: string; text?: string }) =>
              item?.type === "text" && typeof item?.text === "string",
          )
          .map((item: { text: string }) => item.text)
          .join("\n")
          .trim();
      }
    }
    // `result` events contain the final response text
    if (event?.type === "result" && typeof event?.result === "string") {
      return event.result.trim();
    }
  } catch {
    // Non-JSON line — ignore for claude executor
    return "";
  }
  return "";
}

const DEFAULT_MODELS: Record<string, string> = {
  claude_code: "claude-opus-4-6",
  codex: "gpt-5.3-codex",
  opencode: "google/gemini-3-flash-preview",
};

export function startChatExecution(options: ChatExecutorOptions): ChatExecutorHandle {
  const emitter = new EventEmitter();
  const model = options.model || DEFAULT_MODELS[options.executor] || "claude-opus-4-6";
  const prompt = buildPromptFromMessages(options.systemPrompt, options.messages);
  const workdir = tmpdir();
  const env = options.env ?? {};
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;

  let child: ChildProcess;
  switch (options.executor) {
    case "claude_code":
      child = spawnClaudeCode(prompt, model, workdir, env);
      break;
    case "codex":
      child = spawnCodex(prompt, model, workdir, env);
      break;
    case "opencode":
      child = spawnOpencode(prompt, model, workdir, env);
      break;
  }

  let aborted = false;
  let emitted = false;
  // For claude_code: raw stdout for final parsing via parseClaudeCodeStreamJson
  let rawStdout = "";
  let stderr = "";
  let streamBuffer = "";
  // Track cumulative assistant text to compute streaming deltas
  let lastCumulativeText = "";

  const timeout = setTimeout(() => {
    if (!aborted) {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      if (!emitted) {
        emitted = true;
        const timeoutContent = options.executor === "claude_code" ? lastCumulativeText : rawStdout;
        emitter.emit("done", { content: timeoutContent, success: false });
      }
    }
  }, timeoutMs);

  const processClaudeLine = (line: string): void => {
    const text = extractAssistantTextFromStreamLine(line);
    if (!text) return;

    // assistant events are CUMULATIVE — text is the full response so far
    // Compute delta from previous cumulative text
    if (text.length > lastCumulativeText.length && text.startsWith(lastCumulativeText)) {
      const delta = text.slice(lastCumulativeText.length);
      if (delta.length > 0) {
        emitter.emit("chunk", delta);
      }
    } else if (text !== lastCumulativeText) {
      // Text changed in a non-cumulative way (e.g. result event) — emit as delta
      const delta = text.slice(lastCumulativeText.length > 0 ? lastCumulativeText.length : 0);
      if (delta.length > 0) {
        emitter.emit("chunk", delta);
      } else if (text.length > 0 && lastCumulativeText.length === 0) {
        emitter.emit("chunk", text);
      }
    }
    lastCumulativeText = text;
  };

  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();

      rawStdout += chunk;

      if (options.executor === "claude_code") {
        streamBuffer += chunk;
        // Parse stream-json line by line
        while (true) {
          const newlineIndex = streamBuffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = streamBuffer.slice(0, newlineIndex);
          streamBuffer = streamBuffer.slice(newlineIndex + 1);
          processClaudeLine(line);
        }
      } else if (options.executor === "codex") {
        streamBuffer += chunk;
        // Parse NDJSON line by line
        while (true) {
          const newlineIndex = streamBuffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = streamBuffer.slice(0, newlineIndex);
          streamBuffer = streamBuffer.slice(newlineIndex + 1);
          const text = extractCodexAssistantTextFromEventLine(line);
          if (text) {
            emitter.emit("chunk", text);
          }
        }
      } else {
        // For opencode or other executors, emit raw chunks
        emitter.emit("chunk", chunk);
      }
    });
  }

  // Capture stderr for debugging
  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
    });
  }

  child.on("close", (code) => {
    clearTimeout(timeout);
    if (aborted || emitted) return;

    // Flush remaining buffer
    if (streamBuffer.length > 0) {
      if (options.executor === "claude_code") {
        processClaudeLine(streamBuffer);
      }
      // codex remaining buffer is handled by parseCodexExecJson below
      streamBuffer = "";
    }

    let finalContent: string;

    if (options.executor === "claude_code") {
      // Use the proven parseClaudeCodeStreamJson for authoritative final text
      const parsed = parseClaudeCodeStreamJson(rawStdout);
      finalContent = parsed.assistantText || parsed.resultText || lastCumulativeText;

      if (parsed.errors.length > 0) {
        console.error("[ChatExecutor] Claude errors:", parsed.errors.join("; "));
      }
      if (parsed.isError) {
        console.error("[ChatExecutor] Claude result is_error=true:", parsed.resultText);
      }
    } else if (options.executor === "codex") {
      const parsed = parseCodexExecJson(rawStdout);
      finalContent = parsed.assistantText;

      if (parsed.errors.length > 0) {
        console.error("[ChatExecutor] Codex errors:", parsed.errors.join("; "));
      }
      if (parsed.isError) {
        console.error("[ChatExecutor] Codex turn failed");
      }
    } else {
      finalContent = rawStdout;
    }

    if (stderr.trim().length > 0) {
      console.error(`[ChatExecutor] stderr (${options.executor}):`, stderr.trim());
    }

    const success = (code ?? 1) === 0 && finalContent.length > 0;

    if (!success && finalContent.length === 0) {
      console.error(
        `[ChatExecutor] Empty output. executor=${options.executor}, exitCode=${code}, stderrLength=${stderr.length}`,
      );
    }

    emitted = true;
    emitter.emit("done", { content: finalContent, success });
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    if (aborted || emitted) return;
    emitted = true;
    console.error("[ChatExecutor] Process spawn error:", error.message);
    emitter.emit("done", { content: "", success: false });
  });

  return {
    onChunk: (cb) => {
      emitter.on("chunk", cb);
    },
    onDone: (cb) => {
      emitter.on("done", cb);
    },
    abort: () => {
      if (!aborted) {
        aborted = true;
        clearTimeout(timeout);
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }
    },
  };
}
