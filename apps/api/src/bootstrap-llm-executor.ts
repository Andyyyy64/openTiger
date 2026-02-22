import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_LLM_EXECUTOR = "codex" as const;

export type ExecutorKind = "opencode" | "claude_code" | "codex";

let bootstrapLlmExecutorPromise: Promise<ExecutorKind> | null = null;

export function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function resolveCandidatePath(path: string): string {
  return path.startsWith("/") ? path : resolve(path);
}

function uniqueCandidatePaths(candidates: Array<string | undefined>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isNonEmpty(candidate)) {
      continue;
    }
    const absolutePath = resolveCandidatePath(candidate);
    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);
    resolved.push(absolutePath);
  }
  return resolved;
}

async function hasAnyDirectory(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (await directoryExists(path)) {
      return true;
    }
  }
  return false;
}

function hasCodexApiCredential(): boolean {
  return (
    isNonEmpty(process.env.CODEX_API_KEY?.trim()) || isNonEmpty(process.env.OPENAI_API_KEY?.trim())
  );
}

function hasClaudeApiCredential(): boolean {
  return isNonEmpty(process.env.ANTHROPIC_API_KEY?.trim());
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasCodexSubscription(): Promise<boolean> {
  if (hasCodexApiCredential()) {
    return true;
  }
  const homeDir = process.env.HOME?.trim();
  const authDirectories = uniqueCandidatePaths([
    process.env.CODEX_AUTH_DIR?.trim(),
    homeDir ? join(homeDir, ".codex") : undefined,
  ]);
  if (await hasAnyDirectory(authDirectories)) {
    return true;
  }
  return await commandSucceeds("codex", ["login", "status"]);
}

async function hasClaudeCodeSubscription(): Promise<boolean> {
  if (hasClaudeApiCredential()) {
    return true;
  }
  const homeDir = process.env.HOME?.trim();
  const authDirectories = uniqueCandidatePaths([
    process.env.CLAUDE_AUTH_DIR?.trim(),
    process.env.CLAUDE_CONFIG_DIR?.trim(),
    homeDir ? join(homeDir, ".claude") : undefined,
    homeDir ? join(homeDir, ".config", "claude") : undefined,
  ]);
  return await hasAnyDirectory(authDirectories);
}

async function detectBootstrapLlmExecutor(): Promise<ExecutorKind> {
  if (await hasCodexSubscription()) {
    return "codex";
  }
  if (await hasClaudeCodeSubscription()) {
    return "claude_code";
  }
  return DEFAULT_LLM_EXECUTOR;
}

export async function getBootstrapLlmExecutor(): Promise<ExecutorKind> {
  // Cache the initial detection result to minimize external command execution at startup.
  if (!bootstrapLlmExecutorPromise) {
    bootstrapLlmExecutorPromise = detectBootstrapLlmExecutor();
  }
  return bootstrapLlmExecutorPromise;
}
