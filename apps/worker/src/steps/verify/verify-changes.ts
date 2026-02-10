import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getChangedFiles,
  getChangeStats,
  getChangeStatsForFiles,
  getChangedFilesBetweenRefs,
  getDiffBetweenRefs,
  getDiffStatsBetweenRefs,
  refExists,
  getChangedFilesFromRoot,
  getDiffFromRoot,
  getDiffStatsFromRoot,
  getWorkingTreeDiff,
} from "@openTiger/vcs";
import { runOpenCode } from "@openTiger/llm";
import {
  matchDeniedCommand,
  normalizeVerificationCommand,
} from "./command-normalizer";
import { runCommand } from "./command-runner";
import { buildOpenCodeEnv } from "../../env";
import {
  detectLockfilePaths,
  includesInstallCommand,
  isGeneratedPath,
  isGeneratedTypeScriptOutput,
  mergeAllowedPaths,
  normalizePathForMatch,
  touchesPackageManifest,
} from "./paths";
import { checkPolicyViolations } from "./policy";
import { resolveAutoVerificationCommands } from "./repo-scripts";
import { ENV_EXAMPLE_PATHS } from "./constants";
import type { CommandResult, VerifyOptions, VerifyResult } from "./types";

async function cleanupOpenCodeTempDirs(repoPath: string): Promise<void> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    const targets = entries.filter((entry) => entry.name.startsWith(".openTiger-opencode-"));
    await Promise.all(
      targets.map((entry) =>
        rm(join(repoPath, entry.name), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  } catch {
    // ignore cleanup failures and continue verification
  }
}

function isDocumentationFile(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path.startsWith("ops/runbooks/")
  );
}

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
  await cleanupOpenCodeTempDirs(repoPath);

  // 変更されたファイルを取得
  let changedFiles = (await getChangedFiles(repoPath)).map((file) => normalizePathForMatch(file));
  changedFiles = Array.from(new Set(changedFiles.filter((file) => file.length > 0)));
  let stats: { additions: number; deletions: number } = { additions: 0, deletions: 0 };
  let usesCommittedDiff = false;
  let committedDiffRef: { base: string; head: string } | null = null;
  let usesRootDiff = false;

  // コミット済み差分がない場合はbase/headで比較する
  if (changedFiles.length === 0 && baseBranch && headBranch) {
    const committedFiles = await getChangedFilesBetweenRefs(repoPath, baseBranch, headBranch);
    if (committedFiles.length > 0) {
      changedFiles = committedFiles
        .map((file) => normalizePathForMatch(file))
        .filter((file) => file.length > 0);
      const diffStats = await getDiffStatsBetweenRefs(repoPath, baseBranch, headBranch);
      stats = {
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      usesCommittedDiff = true;
      committedDiffRef = { base: baseBranch, head: headBranch };
    } else {
      const baseExists = await refExists(repoPath, baseBranch);
      if (!baseExists) {
        // baseが無い初回コミットはroot diffとして評価する
        const rootFiles = await getChangedFilesFromRoot(repoPath);
        if (rootFiles.length > 0) {
          changedFiles = rootFiles
            .map((file) => normalizePathForMatch(file))
            .filter((file) => file.length > 0);
          const rootStats = await getDiffStatsFromRoot(repoPath);
          stats = {
            additions: rootStats.additions,
            deletions: rootStats.deletions,
          };
          usesCommittedDiff = true;
          usesRootDiff = true;
        }
      }
    }
  }
  const shouldAllowLockfiles =
    includesInstallCommand(commands) || touchesPackageManifest(changedFiles) || allowLockfileOutsidePaths;
  const lockfilePaths = shouldAllowLockfiles ? await detectLockfilePaths(repoPath) : [];
  const effectiveAllowedPaths =
    lockfilePaths.length > 0 ? mergeAllowedPaths(allowedPaths, lockfilePaths) : allowedPaths;
  const finalAllowedPaths = allowEnvExampleOutsidePaths
    ? mergeAllowedPaths(effectiveAllowedPaths, ENV_EXAMPLE_PATHS)
    : effectiveAllowedPaths;
  // 生成物を除外してポリシー判定対象を作る
  const relevantFiles = [];
  let filteredGeneratedCount = 0;
  for (const file of changedFiles) {
    if (isGeneratedPath(file)) {
      filteredGeneratedCount += 1;
      continue;
    }
    if (await isGeneratedTypeScriptOutput(file, repoPath)) {
      continue;
    }
    relevantFiles.push(file);
  }
  console.log(`Changed files: ${changedFiles.length}`);
  if (filteredGeneratedCount > 0) {
    console.log(`Filtered generated files: ${filteredGeneratedCount}`);
  }
  console.log(`Relevant files: ${relevantFiles.length}`);

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
    if (filteredGeneratedCount > 0) {
      // 生成物が大量にある場合でも、判定対象の実変更だけで統計を出す。
      stats = await getChangeStatsForFiles(repoPath, relevantFiles);
    } else {
      stats = await getChangeStats(repoPath);
    }
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

  const buildLightCheckResult = (message: string, success = true): CommandResult => {
    return {
      command: "llm:light-check",
      success,
      outcome: success ? "passed" : "failed",
      stdout: message,
      stderr: "",
      durationMs: 0,
    };
  };

  const isLightCheckStrict =
    (process.env.WORKER_LIGHT_CHECK_MODE ?? "llm").toLowerCase() === "strict";

  // 検証コマンドが無い場合はLLMの簡易チェックに寄せる
  const runLightCheck = async (): Promise<CommandResult> => {
    const mode = (process.env.WORKER_LIGHT_CHECK_MODE ?? "llm").toLowerCase();
    if (mode === "off" || mode === "skip") {
      return buildLightCheckResult("簡易チェックは無効化されています。");
    }

    // 差分の取得元に合わせてdiffを揃える
    const diffResult = committedDiffRef
      ? await getDiffBetweenRefs(repoPath, committedDiffRef.base, committedDiffRef.head)
      : usesRootDiff
        ? await getDiffFromRoot(repoPath)
        : await getWorkingTreeDiff(repoPath);
    const maxChars = Number.parseInt(process.env.WORKER_LIGHT_CHECK_MAX_CHARS ?? "12000", 10);
    const clippedDiff = diffResult.success ? diffResult.stdout.slice(0, Math.max(0, maxChars)) : "";
    const prompt = `
あなたはコード変更の簡易チェック担当です。以下の変更内容から重大な問題がないかだけを確認してください。
ツール呼び出しは禁止です。判断は与えられた情報のみで行ってください。
結論は必ずJSONで返してください。

## 変更ファイル
${changedFiles.map((file) => `- ${file}`).join("\n")}

## 変更統計
- additions: ${stats.additions}
- deletions: ${stats.deletions}

## 変更差分（抜粋）
${clippedDiff || "(diff unavailable)"}

## 出力形式
\`\`\`json
{
  "verdict": "pass" | "warn",
  "summary": "短い所感",
  "concerns": ["気になる点があれば列挙、無ければ空配列"]
}
\`\`\`
`.trim();
    try {
      const env = await buildOpenCodeEnv(repoPath);
      const model =
        process.env.WORKER_LIGHT_CHECK_MODEL ??
        process.env.WORKER_MODEL ??
        process.env.OPENCODE_MODEL ??
        "google/gemini-3-flash-preview";
      const timeoutSeconds = Number.parseInt(
        process.env.WORKER_LIGHT_CHECK_TIMEOUT_SECONDS ?? "120",
        10,
      );
      const result = await runOpenCode({
        workdir: repoPath,
        task: prompt,
        model,
        timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 120,
        env,
        inheritEnv: false,
      });
      const raw = result.stdout ?? "";
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/\{[\s\S]*\}/);
      const payload = jsonMatch?.[1] ?? jsonMatch?.[0];
      if (!payload) {
        return buildLightCheckResult(
          "簡易チェックの応答を解析できませんでした。",
          !isLightCheckStrict,
        );
      }
      const parsed = JSON.parse(payload) as {
        verdict?: "pass" | "warn";
        summary?: string;
        concerns?: string[];
      };
      const verdict = parsed.verdict ?? "warn";
      const summary = parsed.summary ?? "簡易チェックの要約がありません。";
      const concerns = Array.isArray(parsed.concerns) ? parsed.concerns.join(" / ") : "";
      const message = concerns ? `${summary}\n懸念: ${concerns}` : summary;
      if (verdict === "warn" && isLightCheckStrict) {
        return buildLightCheckResult(message, false);
      }
      return buildLightCheckResult(message);
    } catch (error) {
      return buildLightCheckResult(
        `簡易チェックの実行に失敗しましたが処理は続行します: ${String(error)}`,
        !isLightCheckStrict,
      );
    }
  };

  // 検証コマンドを実行
  const commandResults: CommandResult[] = [];
  let allPassed = true;
  let ranCommand = false;
  const autoCommands = await resolveAutoVerificationCommands({
    repoPath,
    changedFiles: relevantFiles,
    explicitCommands: commands,
    deniedCommands: policy.deniedCommands ?? [],
  });
  if (autoCommands.length > 0) {
    console.log(`[Verify] Auto verification commands added: ${autoCommands.join(", ")}`);
  }
  const verificationCommands = [...commands, ...autoCommands];

  if (verificationCommands.length === 0) {
    commandResults.push(await runLightCheck());
    allPassed = commandResults[0]?.success ?? true;
    return {
      success: allPassed,
      commandResults,
      policyViolations: [],
      changedFiles: relevantFiles,
      stats,
    };
  }

  for (const command of verificationCommands) {
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

    const normalizedCommand = normalizeVerificationCommand(command);
    if (normalizedCommand !== command) {
      console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
    }

    console.log(`Running: ${normalizedCommand}`);
    ranCommand = true;
    const result = await runCommand(normalizedCommand, repoPath);
    commandResults.push(result);

    if (result.success && result.outcome === "passed") {
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

  if (allPassed && !ranCommand) {
    const allowLightCheckForCodeChanges =
      (process.env.WORKER_ALLOW_LIGHT_CHECK_FOR_CODE_CHANGES ?? "false").toLowerCase() === "true";
    const isDocOnlyChange =
      relevantFiles.length > 0 && relevantFiles.every((file) => isDocumentationFile(file));

    if (allowLightCheckForCodeChanges || isDocOnlyChange) {
      const lightCheck = await runLightCheck();
      commandResults.push(lightCheck);
      allPassed = lightCheck.success;
    } else {
      const message =
        "No executable verification commands were run for non-documentation changes.";
      commandResults.push({
        command: "verify:guard",
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      allPassed = false;
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
