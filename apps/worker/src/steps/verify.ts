import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getChangedFiles, getChangeStats } from "@h1ve/vcs";
import type { Policy } from "@h1ve/core";
import { minimatch } from "minimatch";

export interface VerifyOptions {
  repoPath: string;
  commands: string[];
  allowedPaths: string[];
  policy: Policy;
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

const GENERATED_PATHS = ["node_modules/**", "dist/**", ".turbo/**", "coverage/**"];
const LOCKFILE_PATHS = ["pnpm-lock.yaml"];
const GENERATED_EXTENSIONS = [".js", ".d.ts", ".d.ts.map"];

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
  return patterns.some((pattern) => minimatch(path, pattern));
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
  const { repoPath, commands, allowedPaths, policy } = options;

  console.log("Verifying changes...");

  // 変更されたファイルを取得
  const changedFiles = await getChangedFiles(repoPath);
  const effectiveAllowedPaths =
    includesInstallCommand(commands) || touchesPackageManifest(changedFiles)
      ? mergeAllowedPaths(allowedPaths, LOCKFILE_PATHS)
      : allowedPaths;
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

  if (changedFiles.length === 0) {
    return {
      success: false,
      commandResults: [],
      policyViolations: [],
      changedFiles: [],
      stats: { additions: 0, deletions: 0 },
      error: "No changes were made",
    };
  }

  if (relevantFiles.length === 0) {
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
  const stats = await getChangeStats(repoPath);
  console.log(`Changes: +${stats.additions} -${stats.deletions}`);

  // ポリシー違反をチェック
  const policyViolations = checkPolicyViolations(
    relevantFiles,
    stats,
    effectiveAllowedPaths,
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

    console.log(`Running: ${command}`);
    const result = await runCommand(command, repoPath);
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
