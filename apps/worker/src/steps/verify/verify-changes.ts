import { relative } from "node:path";
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
import { FAILURE_CODE } from "@openTiger/core";
import { runOpenCode } from "@openTiger/llm";
import { matchDeniedCommand, normalizeVerificationCommand } from "./command-normalizer";
import { runCommand } from "./command-runner";
import { buildOpenCodeEnv } from "../../env";
import {
  detectLockfilePaths,
  includesInstallCommand,
  isGeneratedPathWithPatterns,
  isGeneratedTypeScriptOutput,
  mergeAllowedPaths,
  normalizePathForMatch,
  resolveGeneratedPathPatterns,
  touchesPackageManifest,
} from "./paths";
import { checkPolicyViolations } from "./policy";
import { resolveAutoVerificationCommands } from "./repo-scripts";
import { ENV_EXAMPLE_PATHS } from "./constants";
import { loadVisualProbeDefinitions } from "./visual-probe-contract";
import { runVisualProbes } from "./visual-probe";
import {
  cleanupOpenCodeTempDirs,
  expandVerificationCommandsWithCwd,
  isDocumentationFile,
  resolvePackageScopedRetryCommand,
  resolveSingleAllowedPackageDir,
  resolveSingleChangedPackageDir,
  type VerificationCommandInput,
} from "./verify-command-context";
import { filterUnsupportedAutoCommands } from "./verify-auto-command-filter";
import {
  buildInlineExecuteFailureHint,
  formatVerificationFailureError,
  resolveCommandOutput,
  resolveVerificationCommandFailureCode,
  shouldAttemptInlineCommandRecovery,
  shouldSkipAutoCommandFailure,
  shouldSkipExplicitCommandFailure,
} from "./verify-failure-handling";
import {
  attemptInlineCommandRecovery,
  resolveInlineRecoveryCommandCandidates,
} from "./verify-inline-recovery";
import type {
  CommandResult,
  VerifyFailureCode,
  VerifyOptions,
  VerifyResult,
  VerificationCommandSource,
  VisualProbeResult,
} from "./types";

export {
  expandVerificationCommandsWithCwd,
  filterUnsupportedAutoCommands,
  resolveInlineRecoveryCommandCandidates,
  resolvePackageScopedRetryCommand,
  resolveVerificationCommandFailureCode,
  shouldAttemptInlineCommandRecovery,
  shouldSkipAutoCommandFailure,
  shouldSkipExplicitCommandFailure,
};

// Verify changes
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
    llmInlineRecoveryHandler,
  } = options;

  console.log("Verifying changes...");
  await cleanupOpenCodeTempDirs(repoPath);

  // Get changed files
  let changedFiles = (await getChangedFiles(repoPath)).map((file: string) =>
    normalizePathForMatch(file),
  );
  changedFiles = Array.from(new Set(changedFiles.filter((file: string) => file.length > 0)));
  let stats: { additions: number; deletions: number } = { additions: 0, deletions: 0 };
  let usesCommittedDiff = false;
  let committedDiffRef: { base: string; head: string } | null = null;
  let usesRootDiff = false;

  // If no committed diff, compare base vs head
  if (changedFiles.length === 0 && baseBranch && headBranch) {
    const committedFiles = await getChangedFilesBetweenRefs(repoPath, baseBranch, headBranch);
    if (committedFiles.length > 0) {
      changedFiles = committedFiles
        .map((file: string) => normalizePathForMatch(file))
        .filter((file: string) => file.length > 0);
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
        // First commit without base: evaluate as root diff
        const rootFiles = await getChangedFilesFromRoot(repoPath);
        if (rootFiles.length > 0) {
          changedFiles = rootFiles
            .map((file: string) => normalizePathForMatch(file))
            .filter((file: string) => file.length > 0);
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
  const generatedPathPatterns = await resolveGeneratedPathPatterns(repoPath);
  // Exclude artifacts to build policy-check target
  const relevantFiles = [];
  let filteredGeneratedCount = 0;
  for (const file of changedFiles) {
    if (isGeneratedPathWithPatterns(file, generatedPathPatterns)) {
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
      failureCode: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
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
      failureCode: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
      error: "No relevant changes were made",
    };
  }

  // Get change stats
  if (!usesCommittedDiff) {
    if (filteredGeneratedCount > 0) {
      // Use only actual changes for stats even when artifacts are numerous
      stats = await getChangeStatsForFiles(repoPath, relevantFiles);
    } else {
      stats = await getChangeStats(repoPath);
    }
  }
  console.log(`Changes: +${stats.additions} -${stats.deletions}`);

  // Check policy violations
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
      failureCode: FAILURE_CODE.POLICY_VIOLATION,
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

  // Fall back to LLM light check when no verification commands
  const runLightCheck = async (): Promise<CommandResult> => {
    const mode = (process.env.WORKER_LIGHT_CHECK_MODE ?? "llm").toLowerCase();
    if (mode === "off" || mode === "skip") {
      return buildLightCheckResult("Light check is disabled.");
    }

    // Align diff with the source of changes
    const diffResult = committedDiffRef
      ? await getDiffBetweenRefs(repoPath, committedDiffRef.base, committedDiffRef.head)
      : usesRootDiff
        ? await getDiffFromRoot(repoPath)
        : await getWorkingTreeDiff(repoPath);
    const maxChars = Number.parseInt(process.env.WORKER_LIGHT_CHECK_MAX_CHARS ?? "12000", 10);
    const clippedDiff = diffResult.success ? diffResult.stdout.slice(0, Math.max(0, maxChars)) : "";
    const prompt = `
You are responsible for a lightweight code-change sanity check.
Review the changes below and only flag potentially serious issues.
Do not call tools. Use only the information provided here.
Return JSON only.

## Changed Files
${changedFiles.map((file: string) => `- ${file}`).join("\n")}

## Diff Stats
- additions: ${stats.additions}
- deletions: ${stats.deletions}

## Diff Excerpt
${clippedDiff || "(diff unavailable)"}

## Output Format
\`\`\`json
{
  "verdict": "pass" | "warn",
  "summary": "Short summary",
  "concerns": ["List concerns, or [] if none"]
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
        return buildLightCheckResult("Failed to parse light-check response.", !isLightCheckStrict);
      }
      const parsed = JSON.parse(payload) as {
        verdict?: "pass" | "warn";
        summary?: string;
        concerns?: string[];
      };
      const verdict = parsed.verdict ?? "warn";
      const summary = parsed.summary ?? "Light-check summary was not provided.";
      const concerns = Array.isArray(parsed.concerns) ? parsed.concerns.join(" / ") : "";
      const message = concerns ? `${summary}\nConcerns: ${concerns}` : summary;
      if (verdict === "warn" && isLightCheckStrict) {
        return buildLightCheckResult(message, false);
      }
      return buildLightCheckResult(message);
    } catch (error) {
      return buildLightCheckResult(
        `Light check failed, but processing will continue: ${String(error)}`,
        !isLightCheckStrict,
      );
    }
  };

  // Run verification commands
  const commandResults: CommandResult[] = [];
  let visualProbeResults: VisualProbeResult[] = [];
  let allPassed = true;
  let ranEffectiveCommand = false;
  let ranExplicitEffectiveCommand = false;
  let failureCode: VerifyFailureCode | undefined;
  let failedCommand: string | undefined;
  let failedCommandSource: VerificationCommandSource | undefined;
  let failedCommandStderr: string | undefined;
  const rawAutoCommands = await resolveAutoVerificationCommands({
    repoPath,
    changedFiles: relevantFiles,
    explicitCommands: commands,
    deniedCommands: policy.deniedCommands ?? [],
  });
  const autoCommands = await filterUnsupportedAutoCommands(repoPath, rawAutoCommands);
  const singleChangedPackageDir = await resolveSingleChangedPackageDir(repoPath, relevantFiles);
  const singleAllowedPackageDir = await resolveSingleAllowedPackageDir(repoPath, allowedPaths);
  const packageScopeCandidateDir = singleChangedPackageDir ?? singleAllowedPackageDir;
  const packageScopeCandidateLabel = packageScopeCandidateDir
    ? normalizePathForMatch(relative(repoPath, packageScopeCandidateDir)) || "."
    : undefined;
  if (packageScopeCandidateLabel) {
    console.log(`[Verify] Verification package scope candidate: ${packageScopeCandidateLabel}`);
  }
  if (autoCommands.length > 0) {
    console.log(`[Verify] Auto verification commands added: ${autoCommands.join(", ")}`);
  }
  const baseVerificationCommands: VerificationCommandInput[] = [
    ...commands.map((command) => ({ command, source: "explicit" as const })),
    ...autoCommands.map((command) => ({ command, source: "auto" as const })),
  ];
  const verificationCommands = expandVerificationCommandsWithCwd(
    baseVerificationCommands,
    repoPath,
  );
  const ranNoCommandLightCheck = verificationCommands.length === 0;

  if (ranNoCommandLightCheck) {
    const lightCheckResult = await runLightCheck();
    commandResults.push(lightCheckResult);
    allPassed = lightCheckResult.success;
    if (!allPassed) {
      failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
      failedCommand = lightCheckResult.command;
      failedCommandSource = lightCheckResult.source ?? "light-check";
      failedCommandStderr = lightCheckResult.stderr;
    }
  }

  if (!ranNoCommandLightCheck) {
    for (let index = 0; index < verificationCommands.length; index += 1) {
      const verificationCommand = verificationCommands[index];
      if (!verificationCommand) {
        continue;
      }
      const { command, source, cwd } = verificationCommand;
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
          exitCode: null,
        });
        failedCommand = command;
        failedCommandSource = source;
        failedCommandStderr = message;
        failureCode = FAILURE_CODE.POLICY_VIOLATION;
        allPassed = false;
        break;
      }

      const normalizedCommand = normalizeVerificationCommand(command);
      if (normalizedCommand !== command) {
        console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
      }

      const cwdLabel = normalizePathForMatch(relative(repoPath, cwd)) || ".";
      console.log(
        cwdLabel === "."
          ? `Running: ${normalizedCommand}`
          : `Running: ${normalizedCommand} (cwd: ${cwdLabel})`,
      );
      const result = await runCommand(normalizedCommand, cwd);
      commandResults.push({
        ...result,
        source,
      });

      if (result.success && result.outcome === "passed") {
        ranEffectiveCommand = true;
        if (source === "explicit") {
          ranExplicitEffectiveCommand = true;
        }
        console.log(`  ✓ Passed (${Math.round(result.durationMs / 1000)}s)`);
      } else {
        let output = resolveCommandOutput(result.stderr, result.stdout);
        const packageScopedRetryCommand =
          source === "explicit"
            ? resolvePackageScopedRetryCommand(normalizedCommand)
            : normalizedCommand;
        if (
          packageScopeCandidateDir &&
          packageScopeCandidateLabel &&
          (source === "auto" || packageScopedRetryCommand !== null)
        ) {
          const packageScopedCommand = packageScopedRetryCommand ?? normalizedCommand;
          console.warn(
            `[Verify] Retrying failed ${source} command within package scope (${packageScopeCandidateLabel}): ${packageScopedCommand}`,
          );
          const scopedResult = await runCommand(packageScopedCommand, packageScopeCandidateDir);
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
          output =
            `${output}\n[package-scope:${packageScopeCandidateLabel}] ${packageScopedCommand}: ${scopedOutput}`.trim();
        }

        const hasRemainingCommands = index < verificationCommands.length - 1;
        const isNoOpChange = changedFiles.length === 0 || relevantFiles.length === 0;
        if (
          shouldSkipExplicitCommandFailure({
            source,
            command: normalizedCommand,
            output,
            hasRemainingCommands,
            hasPriorEffectiveCommand: ranEffectiveCommand,
            isDocOnlyChange,
            isNoOpChange,
          })
        ) {
          console.warn(
            `[Verify] Skipping explicit command failure and continuing: ${normalizedCommand}`,
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
        if (
          shouldSkipAutoCommandFailure({
            source,
            command: normalizedCommand,
            output,
            hasRemainingCommands,
            hasPriorEffectiveCommand: ranEffectiveCommand,
            hasPriorExplicitCommandPass: ranExplicitEffectiveCommand,
            isDocOnlyChange,
            isNoOpChange,
          })
        ) {
          console.warn(
            `[Verify] Skipping auto command failure and continuing: ${normalizedCommand}`,
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

        if (
          shouldAttemptInlineCommandRecovery({
            source,
            command: normalizedCommand,
            output,
            hasRemainingCommands,
          })
        ) {
          const inlineRecovery = await attemptInlineCommandRecovery({
            repoPath,
            source,
            failedCommand: normalizedCommand,
            output,
            failedCommandCwd: cwd,
            singleChangedPackageDir: packageScopeCandidateDir,
            deniedCommands: policy.deniedCommands ?? [],
          });
          if (inlineRecovery.attempted) {
            commandResults.push(...inlineRecovery.attemptResults);
            output = `${output}\n[inline-recovery] ${inlineRecovery.summary}`.trim();
          }
          if (inlineRecovery.recovered) {
            console.warn(`[Verify] ${inlineRecovery.summary}`);
            commandResults[commandResults.length - (inlineRecovery.attemptResults.length + 1)] = {
              ...result,
              source,
              success: true,
              outcome: "skipped",
              stderr: output,
            };
            ranEffectiveCommand = true;
            if (source === "explicit") {
              ranExplicitEffectiveCommand = true;
            }
            continue;
          }
        }

        // LLM-driven inline recovery: call LLM to fix the specific command failure in-place
        if (llmInlineRecoveryHandler) {
          const llmInlineMaxAttempts = Number.parseInt(
            process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS ?? "3",
            10,
          );
          const effectiveLlmInlineMax =
            Number.isFinite(llmInlineMaxAttempts) && llmInlineMaxAttempts > 0
              ? llmInlineMaxAttempts
              : 3;
          let llmInlineRecovered = false;
          let lastInlineExecuteFailureHint: string | undefined;
          for (let llmAttempt = 1; llmAttempt <= effectiveLlmInlineMax; llmAttempt++) {
            console.warn(
              `[Verify] LLM inline recovery attempt ${llmAttempt}/${effectiveLlmInlineMax} for: ${normalizedCommand}`,
            );
            const recoveryResult = await llmInlineRecoveryHandler({
              failedCommand: normalizedCommand,
              source,
              stderr: output,
              previousExecuteFailureHint: lastInlineExecuteFailureHint,
              attempt: llmAttempt,
              maxAttempts: effectiveLlmInlineMax,
            });
            if (!recoveryResult.success) {
              lastInlineExecuteFailureHint = buildInlineExecuteFailureHint(
                recoveryResult.executeStderr,
                recoveryResult.executeError,
              );
              console.warn(
                `[Verify] LLM inline recovery execution failed (attempt ${llmAttempt}/${effectiveLlmInlineMax})`,
              );
              continue;
            }
            lastInlineExecuteFailureHint = undefined;
            const effectiveCwd = packageScopeCandidateDir ?? cwd;
            const llmRetryCommand = packageScopeCandidateDir
              ? (resolvePackageScopedRetryCommand(normalizedCommand) ?? normalizedCommand)
              : normalizedCommand;
            const retryResult = await runCommand(llmRetryCommand, effectiveCwd);
            if (retryResult.success && retryResult.outcome === "passed") {
              console.log(
                `  ✓ LLM inline recovery passed (attempt ${llmAttempt}, ${Math.round(retryResult.durationMs / 1000)}s)`,
              );
              commandResults[commandResults.length - 1] = { ...retryResult, source };
              ranEffectiveCommand = true;
              if (source === "explicit") {
                ranExplicitEffectiveCommand = true;
              }
              llmInlineRecovered = true;
              break;
            }
            output = resolveCommandOutput(retryResult.stderr, retryResult.stdout);
          }
          if (llmInlineRecovered) {
            continue;
          }
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
        failureCode = resolveVerificationCommandFailureCode({
          verificationCommands,
          index,
          command: normalizedCommand,
          output,
        });
        allPassed = false;
        break; // Stop on first failure
      }
    }
  }

  if (allPassed && !ranEffectiveCommand && !ranNoCommandLightCheck) {
    const allowLightCheckForCodeChanges =
      (process.env.WORKER_ALLOW_LIGHT_CHECK_FOR_CODE_CHANGES ?? "false").toLowerCase() === "true";

    if (allowLightCheckForCodeChanges || isDocOnlyChange) {
      const lightCheck = await runLightCheck();
      commandResults.push(lightCheck);
      allPassed = lightCheck.success;
      if (!lightCheck.success) {
        failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
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
        exitCode: null,
      });
      failedCommand = "verify:guard";
      failedCommandSource = "guard";
      failedCommandStderr = message;
      failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
      allPassed = false;
    }
  }

  if (allPassed) {
    const visualProbes = await loadVisualProbeDefinitions({
      repoPath,
      changedFiles: relevantFiles,
    });
    if (visualProbes.length > 0) {
      console.log(
        `[Verify] Visual probes configured: ${visualProbes.map((probe) => probe.id).join(", ")}`,
      );
      const probeResult = await runVisualProbes({
        repoPath,
        probes: visualProbes,
      });
      visualProbeResults = probeResult.probeResults;
      commandResults.push(...probeResult.commandResults);
      if (!probeResult.allPassed) {
        allPassed = false;
        failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
        failedCommand = probeResult.failedProbe
          ? `visual-probe:${probeResult.failedProbe.id}`
          : "visual-probe";
        failedCommandSource = "visual-probe";
        failedCommandStderr = probeResult.failedProbe?.message ?? "Visual probe failed";
      }
    }
  }

  return {
    success: allPassed,
    commandResults,
    visualProbeResults,
    policyViolations: [],
    changedFiles: relevantFiles,
    stats,
    failureCode,
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
