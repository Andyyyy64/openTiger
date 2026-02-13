export function isCodexProvider(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex_cli" || normalized === "codex-cli";
}

const IGNORABLE_STDERR_PATTERNS: RegExp[] = [
  /codex_core::rollout::list:\s*state db missing rollout path for thread/i,
];

export function isIgnorableCodexStderrLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return false;
  }
  return IGNORABLE_STDERR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeCodexModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }
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

export function isCodexAuthFailure(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("incorrect api key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("unauthorized")
  );
}

export function isRetryableCodexError(stderr: string, exitCode: number): boolean {
  if (isCodexAuthFailure(stderr)) {
    return false;
  }
  if (exitCode === 0) {
    return false;
  }
  const normalized = stderr.toLowerCase();
  if (normalized.includes("model is not supported")) {
    return false;
  }
  return (
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("timeout") ||
    normalized.includes("etimedout") ||
    normalized.includes("econnreset")
  );
}
