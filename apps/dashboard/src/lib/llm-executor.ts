export type ExecutorMode = "claude_code" | "codex" | "opencode";

export const CLAUDE_CODE_DEFAULT_MODEL = "claude-opus-4-6";
export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";

export function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

export function isCodexExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

export function normalizeExecutor(value?: string): ExecutorMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opencode") {
    return "opencode";
  }
  if (isCodexExecutor(normalized)) {
    return "codex";
  }
  return "claude_code";
}

export function normalizeClaudeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("anthropic/")) {
    return trimmed.slice("anthropic/".length);
  }
  if (trimmed.startsWith("claude")) {
    return trimmed;
  }
  return undefined;
}

export function normalizeCodexModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("openai/")) {
    const stripped = trimmed.slice("openai/".length).trim();
    return stripped.length > 0 ? stripped : undefined;
  }
  const lower = trimmed.toLowerCase();
  const clearlyNonCodexPrefixes = [
    "google/",
    "anthropic/",
    "xai/",
    "deepseek/",
    "groq/",
    "ollama/",
  ];
  if (clearlyNonCodexPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return undefined;
  }
  if (trimmed.includes("/") && !trimmed.startsWith("openai/")) {
    return undefined;
  }
  return trimmed;
}
