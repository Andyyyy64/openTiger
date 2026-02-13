import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@openTiger/core";

// Strip ANSI escape sequences without writing control chars directly
const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function hasGlobPattern(path: string): boolean {
  return /[*?[\]]/.test(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeRetryHint(message: string): string {
  return message
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/external_directory\s*\([^)]*\)/gi, "external_directory(<path>)")
    .replace(/\s+/g, " ")
    .trim();
}

const QUOTA_FAILURE_PATTERNS = [
  /quota exceeded/i,
  /resource has been exhausted/i,
  /resource_exhausted/i,
  /quota limit reached/i,
  /generate_requests_per_model_per_day/i,
  /generate_content_paid_tier_input_token_count/i,
  /retryinfo/i,
];

export function isQuotaFailure(message: string): boolean {
  return QUOTA_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isNoCommitsBetweenError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no commits between");
}

export function shouldAllowNoChanges(task: Task): boolean {
  const text = `${task.title} ${task.goal}`.toLowerCase();
  const role = task.role ?? "worker";
  const expectedFiles = task.context?.files ?? [];
  const commands = task.commands ?? [];
  const allowHints = [
    "verification",
    "verify",
    "validation",
    "check",
    "inspect",
    "typecheck",
    "lint",
    "test",
    "build",
    "check",
  ];
  const denyHints = [
    "setup",
    "set up",
    "initialize",
    "initialization",
    "bootstrap",
    "scaffold",
    "migration",
    "migrate",
    "schema",
    "seed",
    "implement",
    "add",
    "create",
    "modify",
    "change",
    "update",
    "refactor",
    "remove",
    "fix",
  ];

  const allows = allowHints.some((hint) => text.includes(hint));
  const denies = denyHints.some((hint) => text.includes(hint));
  const verificationOnly = isVerificationOnlyCommands(commands);
  const docserNoGapHint = hasDocserNoGapHint(task);

  // Task with explicit target files requires diff
  if (expectedFiles.length > 0) {
    return false;
  }

  if (role === "docser" && docserNoGapHint) {
    return true;
  }

  // worker usually requires diff; only verification-only roles allow no changes
  if (role === "worker") {
    return allows && !denies;
  }

  // Verification-only tester/docser tasks succeed without changes
  return (allows && !denies) || verificationOnly;
}

function isVerificationOnlyCommands(commands: string[]): boolean {
  if (commands.length === 0) {
    return false;
  }

  const dbCommandPattern =
    /\bdrizzle-kit\b|\bdb:(push|generate|migrate|studio)\b|\bpnpm\b[^\n]*--filter[^\n]*\bdb\b[^\n]*\b(push|generate|migrate|studio)\b/i;
  const verificationPatterns = [
    /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(install|i|build|test|lint|typecheck|check|dev)\b/i,
    /\b(vitest|jest|playwright)\b/i,
    dbCommandPattern,
  ];

  // Allow no changes if commands are verification-only
  return commands.every((command) => verificationPatterns.some((pattern) => pattern.test(command)));
}

function hasDocserNoGapHint(task: Task): boolean {
  if ((task.role ?? "worker") !== "docser") {
    return false;
  }

  const notes = task.context?.notes ?? "";
  if (!notes) {
    return false;
  }

  const match = notes.match(/docGap:\s*(\{[\s\S]*?\})/i);
  if (!match?.[1]) {
    return false;
  }

  try {
    const parsed = JSON.parse(match[1]) as { hasGap?: unknown };
    return parsed.hasGap === false;
  } catch {
    return false;
  }
}

export async function validateExpectedFiles(repoPath: string, task: Task): Promise<string[]> {
  // Pre-check whether task expected files exist
  const files = task.context?.files ?? [];
  if (files.length === 0) {
    return [];
  }

  const missing: string[] = [];

  for (const file of files) {
    const normalizedFile = file.trim();
    if (!normalizedFile) {
      continue;
    }

    // Exclude .env from expected files (generated at runtime)
    if (/(^|\/)\.env(\.|$)/.test(normalizedFile)) {
      continue;
    }

    if (hasGlobPattern(normalizedFile)) {
      continue;
    }

    const targetPath = join(repoPath, normalizedFile);

    if (normalizedFile.endsWith("/")) {
      try {
        const stats = await stat(targetPath);
        if (!stats.isDirectory()) {
          missing.push(normalizedFile);
        }
      } catch {
        missing.push(normalizedFile);
      }
      continue;
    }

    // Check specified path first
    if (await pathExists(targetPath)) {
      continue;
    }

    // Fall back to common patterns if not found
    const pathParts = normalizedFile.split("/");
    const foundAlternative = await (async () => {
      // packages/xxx/file.ts -> packages/xxx/src/file.ts
      if (pathParts[0] === "packages" && pathParts.length >= 3) {
        const withSrc = [pathParts[0], pathParts[1], "src", ...pathParts.slice(2)].join("/");
        if (await pathExists(join(repoPath, withSrc))) {
          console.log(`[Worker] Found alternative path: ${withSrc} (original: ${normalizedFile})`);
          return true;
        }
      }
      // apps/xxx/file.ts -> apps/xxx/src/file.ts
      if (pathParts[0] === "apps" && pathParts.length >= 3) {
        const withSrc = [pathParts[0], pathParts[1], "src", ...pathParts.slice(2)].join("/");
        if (await pathExists(join(repoPath, withSrc))) {
          console.log(`[Worker] Found alternative path: ${withSrc} (original: ${normalizedFile})`);
          return true;
        }
      }
      return false;
    })();

    if (!foundAlternative) {
      missing.push(normalizedFile);
    }
  }

  return missing;
}
