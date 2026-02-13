const CODEX_PROVIDER_ALIASES = new Set(["codex", "openai_codex", "openai-codex"]);
const CLEARLY_NON_CODEX_PREFIXES = [
  "anthropic/",
  "google/",
  "xai/",
  "deepseek/",
  "groq/",
  "ollama/",
];

export function isCodexProvider(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return CODEX_PROVIDER_ALIASES.has(normalized);
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
    return trimmed.slice("openai/".length);
  }
  const lower = trimmed.toLowerCase();
  if (CLEARLY_NON_CODEX_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

export function isCodexAuthFailure(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("401 unauthorized") ||
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("authentication failed") ||
    normalized.includes("run `codex login`")
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
