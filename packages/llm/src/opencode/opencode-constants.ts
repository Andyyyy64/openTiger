// Default configuration
export const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? "google/gemini-3-flash-preview";
export const DEFAULT_FALLBACK_MODEL =
  process.env.OPENCODE_FALLBACK_MODEL ?? "google/gemini-2.5-flash";
export const DEFAULT_MAX_RETRIES = parseInt(process.env.OPENCODE_MAX_RETRIES ?? "3", 10);
export const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.OPENCODE_RETRY_DELAY_MS ?? "5000", 10);
export const DEFAULT_WAIT_ON_QUOTA = process.env.OPENCODE_WAIT_ON_QUOTA !== "false";
export const DEFAULT_QUOTA_RETRY_DELAY_MS = parseInt(
  process.env.OPENCODE_QUOTA_RETRY_DELAY_MS ?? "30000",
  10,
);
export const DEFAULT_MAX_QUOTA_WAITS = parseInt(process.env.OPENCODE_MAX_QUOTA_WAITS ?? "-1", 10);

export const RETRYABLE_ERRORS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /503/,
  /502/,
  /overloaded/i,
  /ETIMEDOUT/,
];

export const THOUGHT_SIGNATURE_ERROR = /thought[_\s-]?signature/i;
export const QUOTA_EXCEEDED_ERRORS = [
  /quota exceeded/i,
  /exceeded your current quota/i,
  /generate_requests_per_model_per_day/i,
  // Treat provider resource exhaustion as quota exceeded
  /resource has been exhausted/i,
  /resource_exhausted/i,
  /quotafailure/i,
  /retryinfo/i,
  /generate_content_paid_tier_input_token_count/i,
];
const ANSI_ESCAPE_SEQUENCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
// Build ANSI escape without embedding control chars
export const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_SEQUENCE, "g");
const CONTROL_CHARS_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
// Stabilize prompt detection by stripping control chars
export const CONTROL_CHARS_REGEX = new RegExp(`[${CONTROL_CHARS_CLASS}]+`, "g");

const parseThreshold = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
};

export const DOOM_LOOP_WINDOW = Math.max(
  16,
  parseThreshold(process.env.OPENCODE_DOOM_LOOP_WINDOW, 96),
);
export const DOOM_LOOP_IDENTICAL_THRESHOLD = Math.max(
  0,
  parseThreshold(process.env.OPENCODE_DOOM_LOOP_IDENTICAL_THRESHOLD, 0),
);
export const DOOM_LOOP_PATTERN_MAX_LENGTH = Math.max(
  0,
  parseThreshold(process.env.OPENCODE_DOOM_LOOP_PATTERN_MAX_LENGTH, 0),
);
export const DOOM_LOOP_PATTERN_REPEAT_THRESHOLD = Math.max(
  0,
  parseThreshold(process.env.OPENCODE_DOOM_LOOP_PATTERN_REPEAT_THRESHOLD, 0),
);
export const DEFAULT_IDLE_TIMEOUT_SECONDS = parseInt(
  process.env.OPENCODE_IDLE_TIMEOUT_SECONDS ?? "300",
  10,
);
export const IDLE_CHECK_INTERVAL_MS = 5000;
export const PROGRESS_LOG_INTERVAL_MS = 30000;
export const MAX_CONSECUTIVE_PLANNING_LINES = parseThreshold(
  process.env.OPENCODE_MAX_CONSECUTIVE_PLANNING_LINES,
  0,
);
export const EXTERNAL_PERMISSION_PROMPT = /permission required:\s*external_directory/i;
export const EXTERNAL_PERMISSION_HINTS = [
  "permission required",
  "allow once",
  "always allow",
  "reject",
];
export const PARENT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
