const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);

const ANSI_SEQUENCE_REGEX = new RegExp(
  `${ANSI_ESCAPE}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${ANSI_BELL}]*(?:${ANSI_BELL}|${ANSI_ESCAPE}\\\\))`,
  "gu",
);

export type NormalizedNeofetch = {
  hostLine?: string;
  info: Record<string, string>;
};

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE_REGEX, "");
}

function normalizeKey(rawKey: string): string {
  return rawKey.trim().replace(/\s+/g, " ");
}

function normalizeValue(rawValue: string): string {
  return rawValue.trim().replace(/\s+/g, " ");
}

export function normalizeNeofetchOutput(rawOutput: string): NormalizedNeofetch {
  const normalized = stripAnsi(rawOutput).replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n").map((line) => line.trimEnd());
  const info: Record<string, string> = {};

  let hostLine: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (!hostLine && /\S+@\S+/u.test(trimmed)) {
      hostLine = trimmed;
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizeKey(trimmed.slice(0, separatorIndex));
    const value = normalizeValue(trimmed.slice(separatorIndex + 1));
    if (!key || !value) {
      continue;
    }
    info[key] = value;
  }

  return { hostLine, info };
}
