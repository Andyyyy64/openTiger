import { resolve } from "node:path";

const LEGACY_LOG_DIR_PLACEHOLDER_MARKER = "/absolute/path/to/opentiger";

function isLegacyPlaceholderPath(value: string): boolean {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .toLowerCase()
    .includes(LEGACY_LOG_DIR_PLACEHOLDER_MARKER);
}

export function resolveOpenTigerLogDir(fallbackDir: string): string {
  const candidate =
    process.env.OPENTIGER_LOG_DIR?.trim() || process.env.OPENTIGER_RAW_LOG_DIR?.trim();
  if (candidate && !isLegacyPlaceholderPath(candidate)) {
    return resolve(candidate);
  }
  return resolve(fallbackDir);
}
