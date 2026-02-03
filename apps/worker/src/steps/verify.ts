import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  getChangedFiles,
  getChangeStats,
  getChangedFilesBetweenRefs,
  getDiffStatsBetweenRefs,
} from "@h1ve/vcs";
import type { Policy } from "@h1ve/core";
import { minimatch } from "minimatch";

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

// テスト成果物はポリシー検証から除外する
const GENERATED_PATHS = [
  "node_modules/**",
  "dist/**",
  ".turbo/**",
  "coverage/**",
  "**/playwright-report/**",
  "**/test-results/**",
];
const LOCKFILE_PATHS = ["pnpm-lock.yaml"];
const ENV_EXAMPLE_PATHS = ["**/.env.example"];
const GENERATED_EXTENSIONS = [".js", ".d.ts", ".d.ts.map"];
const DEV_COMMAND_WARMUP_MS = 8000;
const DEV_PORT_IN_USE_PATTERNS = [/Port\s+\d+\s+is already in use/i, /EADDRINUSE/i];
const VERIFICATION_SCRIPT_CANDIDATES = [
  "lint",
  "build",
  "test",
  "typecheck",
  "check",
  "dev",
] as const;

// コマンドを実行
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 300000
): Promise<CommandResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    // シェル経由で実行
    const process = spawn("sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
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
      resolve({
        command,
        success: code === 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    process.on("error", (error) => {
      resolve({
        command,
        success: false,
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// パスがパターンにマッチするか確認
function matchesPattern(path: string, patterns: string[]): boolean {
  // Playwrightの`.last-run.json`などドットファイルも対象に含める
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

// pnpm/npmのtestコマンドは引数の前に"--"が必要なので補正する
function normalizeVerificationCommand(command: string): string {
  let normalized = command;

  if (isE2ECommand(normalized)) {
    const e2ePort = process.env.H1VE_E2E_PORT ?? "5174";
    // PlaywrightのwebServer待機先とViteのポートを一致させる
    normalized = withEnvPrefix(normalized, "VITE_PORT", e2ePort);
    normalized = withEnvPrefix(
      normalized,
      "PLAYWRIGHT_BASE_URL",
      `http://localhost:${e2ePort}`
    );
  }

  if (shouldForceCi(normalized)) {
    // vitestのwatchを抑止して検証を終了させる
    normalized = withEnvPrefix(normalized, "CI", "1");
  }

  // test:e2e のようなサブスクリプトはそのまま実行する
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

function buildDefaultRootScript(scriptName: string): string | undefined {
  switch (scriptName) {
    case "dev":
      return "pnpm -r --parallel --if-present dev";
    case "build":
      return "pnpm -r --if-present build";
    case "lint":
      return "pnpm -r --if-present lint";
    case "typecheck":
      return "pnpm -r --if-present typecheck";
    case "test":
      return "pnpm -r --if-present test";
    case "check":
      return "pnpm -r --if-present check";
    default:
      return undefined;
  }
}

async function ensureRootScript(
  repoPath: string,
  scriptName: string
): Promise<{ added: boolean; error?: string; command?: string }> {
  try {
    const packageJsonPath = join(repoPath, "package.json");
    const content = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, string>;
      [key: string]: unknown;
    };
    if (parsed.scripts?.[scriptName]) {
      return { added: false };
    }
    const command = buildDefaultRootScript(scriptName);
    if (!command) {
      return { added: false };
    }

    // 検証用に最低限のスクリプトを追加する
    parsed.scripts = {
      ...(parsed.scripts ?? {}),
      [scriptName]: command,
    };
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf-8"
    );
    return { added: true, command };
  } catch (error) {
    return {
      added: false,
      error: error instanceof Error ? error.message : String(error),
    };
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

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
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
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// dev起動は常駐するため、短時間だけ起動して落ちないことを確認する
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

  // 既にコミット済みで差分が消えている場合は、baseとheadの差分で確認する
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
  // 生成物はポリシー検証とコミット対象から除外する
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
    // checkスクリプトがない場合は検証コマンドから除外する
    if (isCheckCommand(command) && !checkScriptAvailable) {
      const notice = `Skipped: ${command} (check script not found)`;
      console.warn(`  WARN: ${notice}`);
      commandResults.push({
        command,
        success: true,
        stdout: notice,
        stderr: "",
        durationMs: 0,
      });
      continue;
    }

    const normalizedCommand = normalizeVerificationCommand(command);
    if (normalizedCommand !== command) {
      console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
    }

    const scriptName = resolveRunScript(normalizedCommand);
    if (scriptName && !isFilteredCommand(normalizedCommand) && !rootScripts[scriptName]) {
      const ensureResult = await ensureRootScript(repoPath, scriptName);
      if (ensureResult.added) {
        rootScripts[scriptName] = ensureResult.command ?? "";
        console.warn(
          `  WARN: Added missing root script "${scriptName}" for verification`
        );
      } else if (ensureResult.error) {
        console.warn(
          `  WARN: Failed to add root script "${scriptName}": ${ensureResult.error}`
        );
      }
    }
    if (scriptName && !isFilteredCommand(normalizedCommand) && !rootScripts[scriptName]) {
      const notice = `Skipped: ${normalizedCommand} (script not found: ${scriptName})`;
      console.warn(`  WARN: ${notice}`);
      commandResults.push({
        command: normalizedCommand,
        success: true,
        stdout: notice,
        stderr: "",
        durationMs: 0,
      });
      continue;
    }
    console.log(`Running: ${normalizedCommand}`);
    const result = isDevCommand(normalizedCommand)
      ? await runDevCommand(normalizedCommand, repoPath)
      : await runCommand(normalizedCommand, repoPath);
    commandResults.push(result);

    if (result.success) {
      console.log(`  ✓ Passed (${Math.round(result.durationMs / 1000)}s)`);
    } else {
      console.error(`  ✗ Failed`);
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
