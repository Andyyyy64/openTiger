export function isClaudeCodeProvider(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

export function normalizeClaudeModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("anthropic/")) {
    return trimmed.slice("anthropic/".length);
  }
  // Claude executorにGoogle/OpenAI等のモデルIDが渡された場合は既定モデルにフォールバックする
  const lower = trimmed.toLowerCase();
  const clearlyNonClaudePrefixes = ["google/", "openai/", "xai/", "deepseek/", "groq/", "ollama/"];
  if (clearlyNonClaudePrefixes.some((prefix) => lower.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

export function parseCsvSetting(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function isClaudeAuthFailure(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("/login") ||
    normalized.includes("authentication_failed") ||
    normalized.includes("api key source") ||
    normalized.includes("does not have access to claude code")
  );
}

export function isRetryableClaudeError(stderr: string, exitCode: number): boolean {
  if (isClaudeAuthFailure(stderr)) {
    return false;
  }
  if (exitCode === 0) {
    return false;
  }
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("503") ||
    normalized.includes("502") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("overloaded") ||
    normalized.includes("etimedout") ||
    normalized.includes("econnreset")
  );
}
