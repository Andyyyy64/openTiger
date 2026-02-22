import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";

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

function extractTextFromClaudeStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const event = JSON.parse(trimmed);
    if (event?.type === "assistant" && event?.message?.content) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        return content
          .filter((item: { type?: string; text?: string }) => item?.type === "text" && typeof item?.text === "string")
          .map((item: { text: string }) => item.text)
          .join("");
      }
    }
    // Handle content_block_delta for streaming
    if (event?.type === "content_block_delta" && event?.delta?.text) {
      return event.delta.text;
    }
  } catch {
    // Non-JSON line, return as-is for non-claude executors
    return trimmed;
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

  let fullOutput = "";
  let streamBuffer = "";
  let lastEmittedText = "";
  let aborted = false;

  const timeout = setTimeout(() => {
    if (!aborted) {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      emitter.emit("done", { content: fullOutput, success: false });
    }
  }, timeoutMs);

  const processLine = (line: string): void => {
    let text: string;
    if (options.executor === "claude_code") {
      text = extractTextFromClaudeStreamLine(line);
    } else {
      text = line.trim();
    }
    if (text) {
      fullOutput += text;
      // Emit only new text delta
      if (fullOutput.length > lastEmittedText.length) {
        const delta = fullOutput.slice(lastEmittedText.length);
        lastEmittedText = fullOutput;
        emitter.emit("chunk", delta);
      }
    }
  };

  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      streamBuffer += chunk;

      // For non-claude executors, emit raw chunks directly
      if (options.executor !== "claude_code") {
        fullOutput += chunk;
        emitter.emit("chunk", chunk);
        lastEmittedText = fullOutput;
        return;
      }

      // For claude, parse stream-json line by line
      while (true) {
        const newlineIndex = streamBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = streamBuffer.slice(0, newlineIndex);
        streamBuffer = streamBuffer.slice(newlineIndex + 1);
        processLine(line);
      }
    });
  }

  child.on("close", (code) => {
    clearTimeout(timeout);
    if (aborted) return;
    // Flush remaining buffer
    if (streamBuffer.length > 0 && options.executor === "claude_code") {
      processLine(streamBuffer);
      streamBuffer = "";
    }
    emitter.emit("done", { content: fullOutput, success: (code ?? 1) === 0 });
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    if (aborted) return;
    console.error("[ChatExecutor] Process error:", error.message);
    emitter.emit("done", { content: fullOutput, success: false });
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
