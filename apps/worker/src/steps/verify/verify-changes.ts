import {
  getChangedFiles,
  getChangeStats,
  getChangedFilesBetweenRefs,
  getDiffStatsBetweenRefs,
  refExists,
  getChangedFilesFromRoot,
  getDiffStatsFromRoot,
} from "@openTiger/vcs";
import {
  isCheckCommand,
  isDevCommand,
  isE2ECommand,
  isFilteredCommand,
  isUnsafeRuntimeCommand,
  matchDeniedCommand,
  normalizeVerificationCommand,
  resolveRunScript,
} from "./command-normalizer";
import { runCommand, runDevCommand } from "./command-runner";
import {
  includesInstallCommand,
  isGeneratedPath,
  isGeneratedTypeScriptOutput,
  mergeAllowedPaths,
  touchesPackageManifest,
} from "./paths";
import { checkPolicyViolations } from "./policy";
import { hasRootCheckScript, loadRootScripts } from "./repo-scripts";
import { ENV_EXAMPLE_PATHS, LOCKFILE_PATHS } from "./constants";
import type { CommandResult, VerifyOptions, VerifyResult } from "./types";

// 変更を検証
export async function verifyChanges(options: VerifyOptions): Promise<VerifyResult> {
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

  // コミット済み差分がない場合はbase/headで比較する
  if (changedFiles.length === 0 && baseBranch && headBranch) {
    const committedFiles = await getChangedFilesBetweenRefs(repoPath, baseBranch, headBranch);
    if (committedFiles.length > 0) {
      changedFiles = committedFiles;
      const diffStats = await getDiffStatsBetweenRefs(repoPath, baseBranch, headBranch);
      stats = {
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      usesCommittedDiff = true;
    } else {
      const baseExists = await refExists(repoPath, baseBranch);
      if (!baseExists) {
        // baseが無い初回コミットはroot diffとして評価する
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
    includesInstallCommand(commands) ||
    touchesPackageManifest(changedFiles) ||
    allowLockfileOutsidePaths
      ? mergeAllowedPaths(allowedPaths, LOCKFILE_PATHS)
      : allowedPaths;
  const finalAllowedPaths = allowEnvExampleOutsidePaths
    ? mergeAllowedPaths(effectiveAllowedPaths, ENV_EXAMPLE_PATHS)
    : effectiveAllowedPaths;
  // 生成物を除外してポリシー判定対象を作る
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
  const policyViolations = checkPolicyViolations(relevantFiles, stats, finalAllowedPaths, policy);

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

    // checkスクリプトが無い場合は検証対象から外す
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
