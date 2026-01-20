import { spawn } from "node:child_process";
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

  // 変更統計を取得
  const stats = await getChangeStats(repoPath);
  console.log(`Changes: +${stats.additions} -${stats.deletions}`);

  // ポリシー違反をチェック
  const policyViolations = checkPolicyViolations(
    changedFiles,
    stats,
    allowedPaths,
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
      changedFiles,
      stats,
      error: `Policy violations: ${policyViolations.join(", ")}`,
    };
  }

  // 検証コマンドを実行
  const commandResults: CommandResult[] = [];
  let allPassed = true;

  for (const command of commands) {
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
    changedFiles,
    stats,
    error: allPassed ? undefined : "Verification commands failed",
  };
}
