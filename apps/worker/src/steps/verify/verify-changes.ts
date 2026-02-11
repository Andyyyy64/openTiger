import { access, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
import { matchDeniedCommand, normalizeVerificationCommand } from "./command-normalizer";
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
import type {
  CommandResult,
  VerifyOptions,
  VerifyResult,
  VerificationCommandSource,
} from "./types";

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

type VerificationCommand = {
  command: string;
  source: VerificationCommandSource;
};

const WORKSPACE_ROOT_META_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
  "nx.json",
]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isInsideRepo(repoPath: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(repoPath);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

function isWorkspaceRootMetaFile(file: string): boolean {
  return WORKSPACE_ROOT_META_FILES.has(normalizePathForMatch(file));
}

async function findNearestPackageDir(
  repoPath: string,
  changedFile: string,
): Promise<string | null> {
  const normalizedFile = normalizePathForMatch(changedFile);
  let current = resolve(repoPath, normalizedFile);
  if (!isInsideRepo(repoPath, current)) {
    return null;
  }
  current = dirname(current);

  while (isInsideRepo(repoPath, current)) {
    if (await pathExists(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

async function resolveSingleChangedPackageDir(
  repoPath: string,
  files: string[],
): Promise<string | null> {
  const packageDirs = new Set<string>();

  for (const file of files) {
    if (isWorkspaceRootMetaFile(file)) {
      continue;
    }
    const packageDir = await findNearestPackageDir(repoPath, file);
    if (!packageDir) {
      continue;
    }
    packageDirs.add(packageDir);
    if (packageDirs.size > 1) {
      return null;
    }
  }

  const [singleDir] = Array.from(packageDirs);
  if (!singleDir || resolve(singleDir) === resolve(repoPath)) {
    return null;
  }

  return singleDir;
}

function summarizeCommandError(stderr: string, maxChars = 300): string {
  const normalized = stderr.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function formatVerificationFailureError(params: {
  command?: string;
  source?: VerificationCommandSource;
  stderr?: string;
}): string {
  if (!params.command) {
    return "Verification commands failed";
  }
  const sourceLabel = params.source ? ` [${params.source}]` : "";
  const stderrSummary = summarizeCommandError(params.stderr ?? "");
  return `Verification failed at ${params.command}${sourceLabel}: ${stderrSummary}`;
}

function resolveCommandOutput(stderr: string, stdout: string): string {
  return stderr.trim().length > 0 ? stderr : stdout;
}

function isMissingScriptFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("err_pnpm_no_script") ||
    normalized.includes("missing script") ||
    (normalized.includes("command") &&
      normalized.includes("not found") &&
      normalized.includes("script"))
  );
}

export function shouldSkipExplicitCommandFailure(params: {
  source: VerificationCommandSource;
  command: string;
  output: string;
  hasRemainingCommands: boolean;
  isDocOnlyChange: boolean;
  isNoOpChange: boolean;
}): boolean {
  if (params.source !== "explicit") {
    return false;
  }
  const skipEnabled =
    (process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT ?? "true").toLowerCase() !== "false";
  if (!skipEnabled) {
    return false;
  }
  if (!isMissingScriptFailure(params.output)) {
    return false;
  }
  if (params.hasRemainingCommands) {
    return true;
  }
  return params.isDocOnlyChange || params.isNoOpChange;
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
    includesInstallCommand(commands) ||
    touchesPackageManifest(changedFiles) ||
    allowLockfileOutsidePaths;
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
  const isDocOnlyChange =
    relevantFiles.length > 0 && relevantFiles.every((file) => isDocumentationFile(file));

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
      source: "light-check",
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
  let ranEffectiveCommand = false;
  let failedCommand: string | undefined;
  let failedCommandSource: VerificationCommandSource | undefined;
  let failedCommandStderr: string | undefined;
  const autoCommands = await resolveAutoVerificationCommands({
    repoPath,
    changedFiles: relevantFiles,
    explicitCommands: commands,
    deniedCommands: policy.deniedCommands ?? [],
  });
  const singleChangedPackageDir = await resolveSingleChangedPackageDir(repoPath, relevantFiles);
  const singleChangedPackageLabel = singleChangedPackageDir
    ? normalizePathForMatch(relative(repoPath, singleChangedPackageDir)) || "."
    : undefined;
  if (singleChangedPackageLabel) {
    console.log(`[Verify] Auto command package scope candidate: ${singleChangedPackageLabel}`);
  }
  if (autoCommands.length > 0) {
    console.log(`[Verify] Auto verification commands added: ${autoCommands.join(", ")}`);
  }
  const verificationCommands: VerificationCommand[] = [
    ...commands.map((command) => ({ command, source: "explicit" as const })),
    ...autoCommands.map((command) => ({ command, source: "auto" as const })),
  ];

  if (verificationCommands.length === 0) {
    const lightCheckResult = await runLightCheck();
    commandResults.push(lightCheckResult);
    allPassed = lightCheckResult.success;
    if (!allPassed) {
      failedCommand = lightCheckResult.command;
      failedCommandSource = lightCheckResult.source ?? "light-check";
      failedCommandStderr = lightCheckResult.stderr;
    }
    return {
      success: allPassed,
      commandResults,
      policyViolations: [],
      changedFiles: relevantFiles,
      stats,
      failedCommand,
      failedCommandSource,
      failedCommandStderr,
      error: allPassed
        ? undefined
        : formatVerificationFailureError({
            command: failedCommand,
            source: failedCommandSource,
            stderr: failedCommandStderr,
          }),
    };
  }

  for (let index = 0; index < verificationCommands.length; index += 1) {
    const verificationCommand = verificationCommands[index];
    if (!verificationCommand) {
      continue;
    }
    const { command, source } = verificationCommand;
    const deniedMatch = matchDeniedCommand(command, policy.deniedCommands ?? []);
    if (deniedMatch) {
      const message = `Denied command detected: ${command} (matched: ${deniedMatch})`;
      console.error(`  ✗ ${message}`);
      commandResults.push({
        command,
        source,
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      failedCommand = command;
      failedCommandSource = source;
      failedCommandStderr = message;
      allPassed = false;
      break;
    }

    const normalizedCommand = normalizeVerificationCommand(command);
    if (normalizedCommand !== command) {
      console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
    }

    console.log(`Running: ${normalizedCommand}`);
    const result = await runCommand(normalizedCommand, repoPath);
    commandResults.push({
      ...result,
      source,
    });

    if (result.success && result.outcome === "passed") {
      ranEffectiveCommand = true;
      console.log(`  ✓ Passed (${Math.round(result.durationMs / 1000)}s)`);
    } else {
      let output = resolveCommandOutput(result.stderr, result.stdout);
      if (source === "auto" && singleChangedPackageDir && singleChangedPackageLabel) {
        console.warn(
          `[Verify] Retrying failed auto command within package scope (${singleChangedPackageLabel}): ${normalizedCommand}`,
        );
        const scopedResult = await runCommand(normalizedCommand, singleChangedPackageDir);
        if (scopedResult.success && scopedResult.outcome === "passed") {
          ranEffectiveCommand = true;
          console.log(
            `  ✓ Passed in package scope (${Math.round(scopedResult.durationMs / 1000)}s)`,
          );
          commandResults[commandResults.length - 1] = {
            ...scopedResult,
            source,
          };
          continue;
        }
        const scopedOutput = resolveCommandOutput(scopedResult.stderr, scopedResult.stdout);
        output = `${output}\n[package-scope:${singleChangedPackageLabel}] ${scopedOutput}`.trim();
      }

      const hasRemainingCommands = index < verificationCommands.length - 1;
      if (
        shouldSkipExplicitCommandFailure({
          source,
          command: normalizedCommand,
          output,
          hasRemainingCommands,
          isDocOnlyChange,
          isNoOpChange: changedFiles.length === 0 || relevantFiles.length === 0,
        })
      ) {
        console.warn(
          `[Verify] Skipping explicit command due to missing script and continuing: ${normalizedCommand}`,
        );
        commandResults[commandResults.length - 1] = {
          ...result,
          source,
          success: true,
          outcome: "skipped",
          stderr: output,
        };
        continue;
      }

      if (result.outcome === "skipped") {
        console.error(`  ✗ Skipped (treated as failure)`);
      } else {
        console.error(`  ✗ Failed`);
      }
      ranEffectiveCommand = true;
      console.error(`  stderr: ${output.slice(0, 500)}`);
      failedCommand = normalizedCommand;
      failedCommandSource = source;
      failedCommandStderr = output;
      allPassed = false;
      break; // 最初の失敗で停止
    }
  }

  if (allPassed && !ranEffectiveCommand) {
    const allowLightCheckForCodeChanges =
      (process.env.WORKER_ALLOW_LIGHT_CHECK_FOR_CODE_CHANGES ?? "false").toLowerCase() === "true";

    if (allowLightCheckForCodeChanges || isDocOnlyChange) {
      const lightCheck = await runLightCheck();
      commandResults.push(lightCheck);
      allPassed = lightCheck.success;
      if (!lightCheck.success) {
        failedCommand = lightCheck.command;
        failedCommandSource = lightCheck.source ?? "light-check";
        failedCommandStderr = lightCheck.stderr;
      }
    } else {
      const message = "No executable verification commands were run for non-documentation changes.";
      commandResults.push({
        command: "verify:guard",
        source: "guard",
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      failedCommand = "verify:guard";
      failedCommandSource = "guard";
      failedCommandStderr = message;
      allPassed = false;
    }
  }

  return {
    success: allPassed,
    commandResults,
    policyViolations: [],
    changedFiles: relevantFiles,
    stats,
    failedCommand,
    failedCommandSource,
    failedCommandStderr,
    error: allPassed
      ? undefined
      : formatVerificationFailureError({
          command: failedCommand,
          source: failedCommandSource,
          stderr: failedCommandStderr,
        }),
  };
}
