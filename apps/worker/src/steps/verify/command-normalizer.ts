import { VERIFICATION_SCRIPT_CANDIDATES } from "./constants";

export function isCheckCommand(command: string): boolean {
  return /\b(pnpm|npm)\b[^\n]*\b(run\s+)?check\b/.test(command);
}

export function isDevCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?dev\b/.test(command);
}

export function isUnsafeRuntimeCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?(dev|start|watch)\b/.test(command);
}

export function isE2ECommand(command: string): boolean {
  return /\b(test:e2e|playwright)\b/i.test(command);
}

function hasEnvPrefix(command: string, key: string): boolean {
  return new RegExp(`(^|\\s)${key}=`).test(command);
}

function withEnvPrefix(command: string, key: string, value: string): string {
  if (hasEnvPrefix(command, key)) {
    return command;
  }
  return `${key}=${value} ${command}`;
}

function shouldForceCi(command: string): boolean {
  if (/\btest:/.test(command)) {
    return false;
  }
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\btest\b/.test(command);
}

export function matchDeniedCommand(command: string, deniedCommands: string[]): string | undefined {
  const target = command.trim();
  const lowerTarget = target.toLowerCase();

  for (const denied of deniedCommands) {
    const pattern = denied.trim();
    if (!pattern) {
      continue;
    }

    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(target)) {
        return denied;
      }
    } catch {
      // 非正規表現として扱う
    }

    if (lowerTarget.includes(pattern.toLowerCase())) {
      return denied;
    }
  }

  return undefined;
}

// pnpm/npmのtest系引数は"--"区切りに正規化する
export function normalizeVerificationCommand(command: string): string {
  let normalized = command;

  if (isE2ECommand(normalized)) {
    const e2ePort = process.env.OPENTIGER_E2E_PORT ?? "5174";
    // Playwrightの待機先とViteポートを揃える
    normalized = withEnvPrefix(normalized, "VITE_PORT", e2ePort);
    normalized = withEnvPrefix(normalized, "PLAYWRIGHT_BASE_URL", `http://localhost:${e2ePort}`);
  }

  if (shouldForceCi(normalized)) {
    // vitestのwatchを抑止して検証を完走させる
    normalized = withEnvPrefix(normalized, "CI", "1");
  }

  // test:e2eなどのサブスクリプトはそのまま実行する
  if (/\btest:/.test(normalized)) {
    return normalized;
  }
  const match = normalized.match(/\b(pnpm|npm)\b[^\n]*\btest\b/);
  if (!match || match.index === undefined) {
    return normalized;
  }
  const endIndex = match.index + match[0].length;
  const rest = normalized.slice(endIndex);
  const trimmedRest = rest.trim();
  if (!trimmedRest) {
    return normalized;
  }
  if (trimmedRest.startsWith("-- ")) {
    return normalized;
  }
  if (/^(&&|\|\||;|\|)/.test(trimmedRest)) {
    return normalized;
  }
  return `${normalized.slice(0, endIndex)} -- ${trimmedRest}`;
}

export function resolveRunScript(command: string): string | undefined {
  const runMatch = command.match(/\b(?:pnpm|npm|yarn|bun)\b[^\n]*\brun\s+([^\s]+)/);
  if (runMatch?.[1]) {
    return runMatch[1];
  }

  const filteredShorthandMatch = command.match(
    /^(?:pnpm|npm|yarn|bun)\s+(?:--filter|-F)\s+\S+\s+([^\s]+)/,
  );
  if (filteredShorthandMatch?.[1]) {
    const candidate = filteredShorthandMatch[1];
    if (
      VERIFICATION_SCRIPT_CANDIDATES.includes(
        candidate as (typeof VERIFICATION_SCRIPT_CANDIDATES)[number],
      )
    ) {
      return candidate;
    }
  }

  const shorthandMatch = command.match(/^(?:pnpm|npm|yarn|bun)\s+([^\s]+)/);
  if (!shorthandMatch?.[1]) {
    return undefined;
  }

  const candidate = shorthandMatch[1];
  if (candidate.startsWith("-")) {
    return undefined;
  }

  return VERIFICATION_SCRIPT_CANDIDATES.includes(
    candidate as (typeof VERIFICATION_SCRIPT_CANDIDATES)[number],
  )
    ? candidate
    : undefined;
}

export function isFilteredCommand(command: string): boolean {
  return /\s--filter\b/.test(command) || /\s-F\b/.test(command);
}
