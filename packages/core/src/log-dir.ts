import { resolve } from "node:path";

const LEGACY_LOG_DIR_PLACEHOLDER_MARKER = "/absolute/path/to/opentiger";

function containsLegacyPlaceholderPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/gu, "/").toLowerCase();
  return normalized.includes(LEGACY_LOG_DIR_PLACEHOLDER_MARKER);
}

export function resolveOpenTigerLogDir(options: {
  fallbackDir: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  const candidate = env.OPENTIGER_LOG_DIR?.trim() || env.OPENTIGER_RAW_LOG_DIR?.trim();
  if (candidate && !containsLegacyPlaceholderPath(candidate)) {
    return resolve(candidate);
  }
  return resolve(options.fallbackDir);
}
