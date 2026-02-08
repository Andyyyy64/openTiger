import type { OpenCodeOptions } from "./opencode-types.js";

export function readRuntimeEnv(
  options: OpenCodeOptions,
  key: string
): string | undefined {
  const optionValue = options.env?.[key];
  if (typeof optionValue === "string" && optionValue.trim().length > 0) {
    return optionValue;
  }
  const processValue = process.env[key];
  if (typeof processValue === "string" && processValue.trim().length > 0) {
    return processValue;
  }
  return undefined;
}

export function parseBooleanEnvValue(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function parseIntegerEnvValue(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}
