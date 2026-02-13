export const CODEX_DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";
export const CODEX_DEFAULT_MAX_RETRIES = parseInt(process.env.CODEX_MAX_RETRIES ?? "3", 10);
export const CODEX_DEFAULT_RETRY_DELAY_MS = parseInt(process.env.CODEX_RETRY_DELAY_MS ?? "5000", 10);
