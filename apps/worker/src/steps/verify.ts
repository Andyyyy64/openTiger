import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  getChangedFiles,
  getChangeStats,
  getChangedFilesBetweenRefs,
  getDiffStatsBetweenRefs,
  refExists,
  getChangedFilesFromRoot,
  getDiffStatsFromRoot,
} from "@openTiger/vcs";
import type { Policy } from "@openTiger/core";
import { minimatch } from "minimatch";
import { buildTaskEnv } from "../env.js";

export interface VerifyOptions {
  repoPath: string;
  commands: string[];
  allowedPaths: string[];
  policy: Policy;
  baseBranch?: string;
  headBranch?: string;
  allowLockfileOutsidePaths?: boolean;
  allowEnvExampleOutsidePaths?: boolean;
  allowNoChanges?: boolean;
}

export interface CommandResult {
  command: string;
  success: boolean;
  outcome: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VerifyResult {
  success: boolean;
  commandResults: CommandResult[];
  policyViolations: string[];
  changedFiles: string[];
  stats: { additions: number; deletions: number };
  error?: string;
}

// Exclude test artifacts from policy validation
const GENERATED_PATHS = [
  "node_modules",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  "dist",
  "dist/**",
  "**/dist",
  "**/dist/**",
  ".turbo",
  ".turbo/**",
  "**/.turbo",
  "**/.turbo/**",
  "coverage",
  "coverage/**",
  "**/coverage",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/test-results/**",
  // Never treat judge scratch repos as task outputs
  "apps/judge/test-repo",
  "apps/judge/test-repo/**",
  "apps/judge/repro",
  "apps/judge/repro/**",
];
const LOCKFILE_PATHS = ["pnpm-lock.yaml"];
const ENV_EXAMPLE_PATHS = ["**/.env.example"];
const GENERATED_EXTENSIONS = [".js", ".d.ts", ".d.ts.map"];
const DEV_COMMAND_WARMUP_MS = 8000;
const DEV_PORT_IN_USE_PATTERNS = [/Port\s+\d+\s+is already in use/i, /EADDRINUSE/i];
const SHELL_CONTROL_PATTERN = /&&|\|\||[|;&<>`]/;
const VERIFICATION_SCRIPT_CANDIDATES = [
  "lint",
  "build",
  "test",
  "typecheck",
  "check",
  "dev",
] as const;

type ParsedCommand = {
  executable: string;
  args: string[];
  env: Record<string, string>;
};

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (SHELL_CONTROL_PATTERN.test(trimmed)) {
    return null;
  }

  const tokens = tokenizeCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const env: Record<string, string> = {};
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      break;
    }
    const eqIndex = token.indexOf("=");
    env[token.slice(0, eqIndex)] = token.slice(eqIndex + 1);
    index += 1;
  }

  const executable = tokens[index];
  if (!executable) {
    return null;
  }

  return {
    executable,
    args: tokens.slice(index + 1),
    env,
  };
}

// コマンドを実行
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 300000
): Promise<CommandResult> {
  const startTime = Date.now();
  const baseEnv = await buildTaskEnv(cwd);
  const parsed = parseCommand(command);
  if (!parsed) {
    return {
      command,
      success: false,
      outcome: "failed",
      stdout: "",
      stderr: "Unsupported command format. Shell operators are not allowed.",
      durationMs: Date.now() - startTime,
    };
  }
  const env = {
    ...baseEnv,
    ...parsed.env,
  };

  return new Promise((resolve) => {
    const process = spawn(parsed.executable, parsed.args, {
      cwd,
      timeout: timeoutMs,
      env,
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      const success = code === 0;
      resolve({
        command,
        success,
        outcome: success ? "passed" : "failed",
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    process.on("error", (error) => {
      resolve({
        command,
        success: false,
        outcome: "failed",
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// Check if path matches pattern
function matchesPattern(path: string, patterns: string[]): boolean {
  // Include dot files like Playwright's `.last-run.json`
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

function isGeneratedPath(path: string): boolean {
  return matchesPattern(path, GENERATED_PATHS);
}

function mergeAllowedPaths(current: string[], extra: string[]): string[] {
  const merged = new Set(current);
  for (const path of extra) {
    merged.add(path);
  }
  return Array.from(merged);
}

function includesInstallCommand(commands: string[]): boolean {
  return commands.some((command) => /\bpnpm\b[^\n]*\b(install|add|i)\b/.test(command));
}

function isCheckCommand(command: string): boolean {
  return /\b(pnpm|npm)\b[^\n]*\b(run\s+)?check\b/.test(command);
}

function isDevCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?dev\b/.test(command);
}

function isUnsafeRuntimeCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?(dev|start|watch)\b/.test(command);
}

function isE2ECommand(command: string): boolean {
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

function matchDeniedCommand(
  command: string,
  deniedCommands: string[]
): string | undefined {
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

// Correct for pnpm/npm test commands which require "--" before arguments
function normalizeVerificationCommand(command: string): string {
  let normalized = command;

  if (isE2ECommand(normalized)) {
    const e2ePort = process.env.OPENTIGER_E2E_PORT ?? "5174";
    // Match Playwright webServer wait target with Vite port
    normalized = withEnvPrefix(normalized, "VITE_PORT", e2ePort);
    normalized = withEnvPrefix(
      normalized,
      "PLAYWRIGHT_BASE_URL",
      `http://localhost:${e2ePort}`
    );
  }

  if (shouldForceCi(normalized)) {
    // Suppress vitest watch to allow verification to complete
    normalized = withEnvPrefix(normalized, "CI", "1");
  }

  // Execute subscripts like test:e2e as-is
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

async function loadRootScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function resolveRunScript(command: string): string | undefined {
  const runMatch = command.match(/\b(?:pnpm|npm|yarn|bun)\b[^\n]*\brun\s+([^\s]+)/);
  if (runMatch?.[1]) {
    return runMatch[1];
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
    candidate as (typeof VERIFICATION_SCRIPT_CANDIDATES)[number]
  )
    ? candidate
    : undefined;
}

function isFilteredCommand(command: string): boolean {
  return /\s--filter\b/.test(command) || /\s-F\b/.test(command);
}

function buildPortOverrideCommand(command: string, port: number): string | null {
  if (/\s--port\b/.test(command)) {
    return null;
  }
  if (/\b(pnpm|npm|yarn|bun)\b[^\n]*\brun\b/.test(command)) {
    return `${command} -- --port ${port}`;
  }
  if (/^(?:pnpm|npm|yarn|bun)\s+dev\b/.test(command)) {
    return `${command} -- --port ${port}`;
  }
  return `${command} --port ${port}`;
}

// Vite系の「ポート使用中」エラーを検知して退避起動する
function shouldRetryDevWithPort(stderr: string): boolean {
  return DEV_PORT_IN_USE_PATTERNS.some((pattern) => pattern.test(stderr));
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Failed to acquire an available port"));
      }
    });
  });
}

async function runDevCommandOnce(
  command: string,
  cwd: string,
  warmupMs = DEV_COMMAND_WARMUP_MS
): Promise<CommandResult> {
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const baseEnv = await buildTaskEnv(cwd);
  const parsed = parseCommand(command);
  if (!parsed) {
    return {
      command,
      success: false,
      outcome: "failed",
      stdout,
      stderr: "Unsupported command format. Shell operators are not allowed.",
      durationMs: Date.now() - startTime,
    };
  }
  const env = {
    ...baseEnv,
    ...parsed.env,
  };

  return new Promise((resolve) => {
    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      detached: true,
      env,
    });
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          globalThis.process.kill(-child.pid, signal);
          return;
        } catch {
          // フォールバックで単体プロセスを止める
        }
      }
      child.kill(signal);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 2000);
    }, warmupMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const success = timedOut ? true : code === 0;
      resolve({
        command,
        success,
        outcome: success ? "passed" : "failed",
        stdout: timedOut
          ? `${stdout}\n[dev-check] warmup completed, process terminated`
          : stdout,
        stderr,
        durationMs,
      });
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      resolve({
        command,
        success: false,
        outcome: "failed",
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// dev startup is persistent, so verify it starts and doesn't crash in short time
async function runDevCommand(
  command: string,
  cwd: string,
  warmupMs = DEV_COMMAND_WARMUP_MS
): Promise<CommandResult> {
  const result = await runDevCommandOnce(command, cwd, warmupMs);
  if (!result.success && shouldRetryDevWithPort(result.stderr)) {
    try {
      const port = await findAvailablePort();
      const override = buildPortOverrideCommand(command, port);
      if (override) {
        const retryResult = await runDevCommandOnce(override, cwd, warmupMs);
        if (retryResult.success) {
          return {
            ...retryResult,
            stdout: `${retryResult.stdout}\n[dev-check] port override: ${port}`,
          };
        }
        return retryResult;
      }
    } catch {
      return result;
    }
  }
  return result;
}

function touchesPackageManifest(files: string[]): boolean {
  return files.some((file) =>
    file === "package.json"
    || file.endsWith("/package.json")
    || file === "pnpm-workspace.yaml"
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasRootCheckScript(repoPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.check === "string";
  } catch {
    return false;
  }
}

async function isGeneratedTypeScriptOutput(
  file: string,
  repoPath: string
): Promise<boolean> {
  if (!GENERATED_EXTENSIONS.some((ext) => file.endsWith(ext))) {
    return false;
  }

  const withoutMap = file.endsWith(".d.ts.map")
    ? file.replace(/\.d\.ts\.map$/, "")
    : file;
  const base = withoutMap.endsWith(".d.ts")
    ? withoutMap.replace(/\.d\.ts$/, "")
    : withoutMap.replace(/\.js$/, "");

  const tsPath = join(repoPath, `${base}.ts`);
  const tsxPath = join(repoPath, `${base}.tsx`);

  return (await fileExists(tsPath)) || (await fileExists(tsxPath));
}

// ポリシー違反をチェック
function checkPolicyViolations(
  changedFiles: string[],
  stats: { additions: number; deletions: number },
  allowedPaths: string[],
  policy: Policy
): string[] {
  const violations: string[] = [];

  // 変更行数チェック
  const totalChanges = stats.additions + stats.deletions;
  if (totalChanges > policy.maxLinesChanged) {
    violations.push(
      `Too many lines changed: ${totalChanges} (max: ${policy.maxLinesChanged})`
    );
  }

  // 変更ファイル数チェック
  if (changedFiles.length > policy.maxFilesChanged) {
    violations.push(
      `Too many files changed: ${changedFiles.length} (max: ${policy.maxFilesChanged})`
    );
  }

  // 許可パス外の変更チェック
  for (const file of changedFiles) {
    const isAllowed = matchesPattern(file, allowedPaths);
    const isDenied = matchesPattern(file, policy.deniedPaths);

    if (isDenied) {
      violations.push(`Change to denied path: ${file}`);
    } else if (!isAllowed) {
      violations.push(`Change outside allowed paths: ${file}`);
    }
  }

  return violations;
}

// 変更を検証
export async function verifyChanges(
  options: VerifyOptions
): Promise<VerifyResult> {
  const {
    repoPath,
    commands,
    allowedPaths,
    policy,
    baseBranch,
    headBranch,
    allowLockfileOutsidePaths = false,
    allowEnvExampleOutsidePaths = false,
    allowNoChanges = false,
  } = options;

  console.log("Verifying changes...");

  // 変更されたファイルを取得
  let changedFiles = await getChangedFiles(repoPath);
  let stats: { additions: number; deletions: number } = { additions: 0, deletions: 0 };
  let usesCommittedDiff = false;

  // If already committed and diff is gone, check with base and head diff
  if (changedFiles.length === 0 && baseBranch && headBranch) {
    const committedFiles = await getChangedFilesBetweenRefs(
      repoPath,
      baseBranch,
      headBranch
    );
    if (committedFiles.length > 0) {
      changedFiles = committedFiles;
      const diffStats = await getDiffStatsBetweenRefs(
        repoPath,
        baseBranch,
        headBranch
      );
      stats = {
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      usesCommittedDiff = true;
    } else {
      const baseExists = await refExists(repoPath, baseBranch);
      if (!baseExists) {
        // Evaluate first commit without base branch as root diff
        const rootFiles = await getChangedFilesFromRoot(repoPath);
        if (rootFiles.length > 0) {
          changedFiles = rootFiles;
          const rootStats = await getDiffStatsFromRoot(repoPath);
          stats = {
            additions: rootStats.additions,
            deletions: rootStats.deletions,
          };
          usesCommittedDiff = true;
        }
      }
    }
  }
  const effectiveAllowedPaths =
    includesInstallCommand(commands)
    || touchesPackageManifest(changedFiles)
    || allowLockfileOutsidePaths
      ? mergeAllowedPaths(allowedPaths, LOCKFILE_PATHS)
      : allowedPaths;
  const finalAllowedPaths =
    allowEnvExampleOutsidePaths
      ? mergeAllowedPaths(effectiveAllowedPaths, ENV_EXAMPLE_PATHS)
      : effectiveAllowedPaths;
  // Exclude generated files from policy validation and commit targets
  const relevantFiles = [];
  for (const file of changedFiles) {
    if (isGeneratedPath(file)) {
      continue;
    }
    if (await isGeneratedTypeScriptOutput(file, repoPath)) {
      continue;
    }
    relevantFiles.push(file);
  }
  console.log(`Changed files: ${changedFiles.length}`);

  if (changedFiles.length === 0 && !allowNoChanges) {
    return {
      success: false,
      commandResults: [],
      policyViolations: [],
      changedFiles: [],
      stats: { additions: 0, deletions: 0 },
      error: "No changes were made",
    };
  }

  if (relevantFiles.length === 0 && !allowNoChanges) {
    return {
      success: false,
      commandResults: [],
      policyViolations: [],
      changedFiles: [],
      stats: { additions: 0, deletions: 0 },
      error: "No relevant changes were made",
    };
  }

  // 変更統計を取得
  if (!usesCommittedDiff) {
    stats = await getChangeStats(repoPath);
  }
  console.log(`Changes: +${stats.additions} -${stats.deletions}`);

  // ポリシー違反をチェック
  const policyViolations = checkPolicyViolations(
    relevantFiles,
    stats,
    finalAllowedPaths,
    policy
  );

  if (policyViolations.length > 0) {
    console.error("Policy violations found:");
    for (const violation of policyViolations) {
      console.error(`  - ${violation}`);
    }

    return {
      success: false,
      commandResults: [],
      policyViolations,
      changedFiles: relevantFiles,
      stats,
      error: `Policy violations: ${policyViolations.join(", ")}`,
    };
  }

  // 検証コマンドを実行
  const commandResults: CommandResult[] = [];
  let allPassed = true;
  const checkScriptAvailable = await hasRootCheckScript(repoPath);

  const rootScripts = await loadRootScripts(repoPath);

  for (const command of commands) {
    const deniedMatch = matchDeniedCommand(command, policy.deniedCommands ?? []);
    if (deniedMatch) {
      const message = `Denied command detected: ${command} (matched: ${deniedMatch})`;
      console.error(`  ✗ ${message}`);
      commandResults.push({
        command,
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      allPassed = false;
      break;
    }

    // Exclude from verification commands if check script doesn't exist
    if (isCheckCommand(command) && !checkScriptAvailable) {
      const notice = `Skipped: ${command} (check script not found)`;
      console.error(`  ✗ ${notice}`);
      commandResults.push({
        command,
        success: false,
        outcome: "skipped",
        stdout: notice,
        stderr: "",
        durationMs: 0,
      });
      allPassed = false;
      break;
    }

    if (isUnsafeRuntimeCommand(command) && !isE2ECommand(command)) {
      const notice = `Skipped: ${command} (runtime/watch command is not allowed in verification)`;
      console.error(`  ✗ ${notice}`);
      commandResults.push({
        command,
        success: false,
        outcome: "skipped",
        stdout: notice,
        stderr: "",
        durationMs: 0,
      });
      allPassed = false;
      break;
    }

    const normalizedCommand = normalizeVerificationCommand(command);
    if (normalizedCommand !== command) {
      console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
    }

    const scriptName = resolveRunScript(normalizedCommand);
    if (scriptName && !isFilteredCommand(normalizedCommand) && !rootScripts[scriptName]) {
      const notice = `Skipped: ${normalizedCommand} (script not found: ${scriptName})`;
      console.error(`  ✗ ${notice}`);
      commandResults.push({
        command: normalizedCommand,
        success: false,
        outcome: "skipped",
        stdout: notice,
        stderr: "",
        durationMs: 0,
      });
      allPassed = false;
      break;
    }
    console.log(`Running: ${normalizedCommand}`);
    const result = isDevCommand(normalizedCommand)
      ? await runDevCommand(normalizedCommand, repoPath)
      : await runCommand(normalizedCommand, repoPath);
    commandResults.push(result);

    if (result.success) {
      console.log(`  ✓ Passed (${Math.round(result.durationMs / 1000)}s)`);
    } else {
      if (result.outcome === "skipped") {
        console.error(`  ✗ Skipped (treated as failure)`);
      } else {
        console.error(`  ✗ Failed`);
      }
      console.error(`  stderr: ${result.stderr.slice(0, 500)}`);
      allPassed = false;
      break; // 最初の失敗で停止
    }
  }

  return {
    success: allPassed,
    commandResults,
    policyViolations: [],
    changedFiles: relevantFiles,
    stats,
    error: allPassed ? undefined : "Verification commands failed",
  };
}
