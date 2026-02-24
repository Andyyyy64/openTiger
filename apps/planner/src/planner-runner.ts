import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { getRepoMode, resolveDeterministicTargetArea } from "@openTiger/core";
import { resolveGitHubAuthMode, resolveGitHubToken } from "@openTiger/vcs";
import { and, eq, sql } from "drizzle-orm";
import { loadPlugins, registerPlugin } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

import {
  detectMissingRequirementFields,
  parseRequirementFile,
  parseRequirementContent,
  validateRequirement,
  type RequirementFieldName,
  type Requirement,
} from "./parser";
import { completeRequirementWithLlm } from "./requirement-completion";
import { buildRequirementSyncTask, injectRequirementSyncTask } from "./requirement-sync-task";
import {
  generateTasksFromRequirement,
  generateSimpleTasks,
  type TaskGenerationResult,
} from "./strategies/index";
import { inspectCodebase, formatInspectionNotes } from "./inspection";
import type { CodebaseInspection } from "./inspection";
import {
  normalizeGeneratedTasks,
  applyTaskRolePolicy,
  applyPolicyRecoveryPathHints,
  applyVerificationCommandPolicy,
  applyTesterCommandPolicy,
  applyDevCommandPolicy,
  generateInitializationTasks,
  loadTaskPolicyOverridesFromRepo,
  sanitizeTaskDependencyIndexes,
  reduceRedundantDependencyIndexes,
  ensureInitializationTaskForUninitializedRepo,
} from "./task-policies";
import {
  hasRootCheckScript,
  resolveCheckVerificationCommand,
  resolveDevVerificationCommand,
  resolveE2EVerificationCommand,
} from "./planner-commands";
import { detectDocGap, hasPendingDocserTask, buildDocserTaskForGap } from "./planner-docs";
import {
  attachExistingTasksToRequirement,
  attachInspectionToRequirement,
  attachInspectionToTasks,
  attachJudgeFeedbackToRequirement,
  attachJudgeFeedbackToTasks,
  attachPolicyRecoveryHintsToRequirement,
  loadExistingTaskHints,
  loadJudgeFeedback,
  loadPolicyRecoveryPathHints,
  type PolicyRecoveryPathHint,
} from "./planner-notes";
import { clipText, getErrorMessage, isRepoUninitialized } from "./planner-utils";
import { augmentVerificationCommandsForTasks } from "./planner-verification";
import { applyHotFilePlanning } from "./hot-file-planning";
import {
  computePlanSignature,
  resolvePlanDedupeWindowMs,
  tryAcquirePlanSaveLock,
  wasPlanRecentlyCreated,
} from "./planner-signature";
import {
  createIssuesForTasks,
  recordPlannerPlanEvent,
  resolveDependencies,
  saveTasks,
} from "./planner-tasks";
import { DEFAULT_CONFIG, type PlannerConfig } from "./planner-config";

function appendPlannerWarning(result: TaskGenerationResult, warning: string): TaskGenerationResult {
  return {
    ...result,
    warnings: [...result.warnings, warning],
  };
}

function applyDeterministicTargetAreas(result: TaskGenerationResult): TaskGenerationResult {
  return {
    ...result,
    tasks: result.tasks.map((task, index) => {
      const targetArea = resolveDeterministicTargetArea({
        id: `plan:${index}`,
        kind: task.kind,
        targetArea: task.targetArea,
        touches: task.touches,
        allowedPaths: task.allowedPaths,
        context: task.context,
      });
      return {
        ...task,
        targetArea: targetArea ?? undefined,
      };
    }),
  };
}

function isTaskParseFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to parse llm response") ||
    normalized.includes("no valid json found in response") ||
    (normalized.includes("json") && normalized.includes("parse"))
  );
}

function canUseGitHubIssueLinking(): boolean {
  if (getRepoMode() !== "github") {
    return false;
  }
  if (!process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    return false;
  }
  try {
    resolveGitHubToken({
      authMode: resolveGitHubAuthMode(process.env.GITHUB_AUTH_MODE),
    });
    return true;
  } catch {
    return false;
  }
}

async function enrichRequirementIfMissing(params: {
  requirement: Requirement;
  useLlm: boolean;
  workdir: string;
  timeoutSeconds: number;
}): Promise<{
  requirement: Requirement;
  completionApplied: boolean;
  missingFields: RequirementFieldName[];
}> {
  const missingFields = detectMissingRequirementFields(params.requirement.rawContent);
  if (missingFields.length === 0) {
    return {
      requirement: params.requirement,
      completionApplied: false,
      missingFields,
    };
  }

  console.warn(`[Planner] Requirement missing sections: ${missingFields.join(", ")}`);
  if (!params.useLlm) {
    console.warn("[Planner] LLM completion skipped (USE_LLM=false). Using fallback defaults.");
    return {
      requirement: params.requirement,
      completionApplied: false,
      missingFields,
    };
  }

  try {
    const completed = await completeRequirementWithLlm({
      workdir: params.workdir,
      timeoutSeconds: params.timeoutSeconds,
      rawContent: params.requirement.rawContent,
      current: params.requirement,
      missingFields,
    });
    if (completed.warnings.length > 0) {
      console.warn(`[Planner] Requirement completion warnings: ${completed.warnings.join(" | ")}`);
    }
    console.log("[Planner] Requirement was complemented by LLM for missing sections.");
    return {
      requirement: completed.requirement,
      completionApplied: true,
      missingFields,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Planner] Requirement completion failed; continuing with fallback defaults. reason=${message}`,
    );
    return {
      requirement: params.requirement,
      completionApplied: false,
      missingFields,
    };
  }
}

async function applyPlannerTaskPolicies(params: {
  result: TaskGenerationResult;
  requirement: Requirement;
  workdir: string;
  checkScriptAvailable: boolean;
  e2eCommand?: string;
  devCommand?: string;
  judgeFeedback?: string;
  inspectionNotes?: string;
  policyRecoveryHints?: PolicyRecoveryPathHint[];
}): Promise<TaskGenerationResult> {
  let next = sanitizeTaskDependencyIndexes(params.result);
  next = reduceRedundantDependencyIndexes(next);
  next = normalizeGeneratedTasks(next);
  next = applyTaskRolePolicy(next);
  next = await augmentVerificationCommandsForTasks({
    workdir: params.workdir,
    requirement: params.requirement,
    result: next,
  });
  next = applyVerificationCommandPolicy(next, params.checkScriptAvailable);
  next = applyTesterCommandPolicy(next, params.e2eCommand);
  next = applyDevCommandPolicy(next, params.devCommand);
  next = applyPolicyRecoveryPathHints(next, params.policyRecoveryHints ?? []);
  next = attachJudgeFeedbackToTasks(next, params.judgeFeedback);
  next = attachInspectionToTasks(next, params.inspectionNotes);
  next = applyDeterministicTargetAreas(next);
  const hotFileResult = await applyHotFilePlanning(next.tasks);
  if (hotFileResult.overlapCount > 0) {
    next = {
      ...next,
      tasks: hotFileResult.tasks,
      warnings: [
        ...next.warnings,
        `Hot-file overlap detector added dependencies to ${hotFileResult.overlapCount} task(s).`,
      ],
    };
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeResearchStage(
  value: string | undefined,
): "plan" | "collect" | "challenge" | "write" {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "plan" ||
    normalized === "planning" ||
    normalized === "decompose" ||
    normalized === "decomposition"
  ) {
    return "plan";
  }
  if (normalized === "challenge" || normalized === "challenging") {
    return "challenge";
  }
  if (
    normalized === "write" ||
    normalized === "compose" ||
    normalized === "composing" ||
    normalized === "report"
  ) {
    return "write";
  }
  return "collect";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

type PlannerHookEntry = {
  id: string;
  hook: NonNullable<ReturnType<typeof loadPlugins>["enabledPlugins"][number]["planner"]>;
};

export async function planFromResearchJob(
  researchJobId: string,
  config: PlannerConfig,
  agentId: string,
): Promise<void> {
  const pluginResult = loadPlugins({
    enabledPluginsCsv: process.env.ENABLED_PLUGINS,
  });
  const plannerHooks = pluginResult.enabledPlugins
    .map((plugin) => ({ id: plugin.id, hook: plugin.planner }))
    .filter((entry): entry is PlannerHookEntry => Boolean(entry.hook));

  let handled = false;
  for (const entry of plannerHooks) {
    if (entry.hook.handleJob) {
      console.log(`\n[Planner] Delegating job ${researchJobId} to plugin: ${entry.id}`);
      await entry.hook.handleJob({
        jobId: researchJobId,
        config: config as unknown as Record<string, unknown>,
        agentId,
      });
      handled = true;
      break;
    }
  }

  if (!handled) {
    throw new Error(
      `No enabled plugin can handle research-job planning. Update system config ENABLED_PLUGINS and restart managed processes.`,
    );
  }
}

// Generate tasks from requirement file
export async function planFromRequirement(
  requirementPath: string,
  config: PlannerConfig,
  agentId: string,
): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Planner - Task Generation");
  console.log("=".repeat(60));
  console.log(`Requirement file: ${requirementPath}`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log("=".repeat(60));

  // Load requirement file
  let requirement: Requirement;
  try {
    requirement = await parseRequirementFile(requirementPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read requirement file: ${message}`);
  }
  const requirementCompletion = await enrichRequirementIfMissing({
    requirement,
    useLlm: config.useLlm,
    workdir: config.workdir,
    timeoutSeconds: config.timeoutSeconds,
  });
  requirement = requirementCompletion.requirement;

  // Validate requirement
  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    console.error("Validation errors:");
    for (const error of validationErrors) {
      console.error(`  - ${error}`);
    }
    throw new Error("Validation failed");
  }

  await loadTaskPolicyOverridesFromRepo(config.workdir);

  console.log("\n[Parsed Requirement]");
  console.log(`Goal: ${requirement.goal}`);
  console.log(`Acceptance Criteria: ${requirement.acceptanceCriteria.length} items`);
  console.log(`Allowed Paths: ${requirement.allowedPaths.join(", ")}`);

  const judgeFeedback = await loadJudgeFeedback();
  if (judgeFeedback) {
    console.log("\n[Planner] Loaded judge feedback for context.");
    requirement = attachJudgeFeedbackToRequirement(requirement, judgeFeedback);
  }
  const existingTaskHints = await loadExistingTaskHints();
  requirement = attachExistingTasksToRequirement(requirement, existingTaskHints);
  const policyRecoveryHints = await loadPolicyRecoveryPathHints();
  if (policyRecoveryHints.length > 0) {
    console.log(
      `\n[Planner] Loaded ${policyRecoveryHints.length} policy recovery hint(s) for proactive allowedPaths.`,
    );
  }
  requirement = attachPolicyRecoveryHintsToRequirement(requirement, policyRecoveryHints);
  const checkScriptAvailable = await hasRootCheckScript(config.workdir);
  if (!checkScriptAvailable) {
    console.log("[Planner] No check script found; adjusting verification commands.");
  }
  const devCommand = await resolveDevVerificationCommand(config.workdir);
  const checkCommand = await resolveCheckVerificationCommand(config.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(config.workdir);
  const repoUninitialized = await isRepoUninitialized(config.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;

  if (!repoUninitialized && !config.useLlm) {
    console.error("[Planner] Inspection is required; LLM cannot be disabled.");
    throw new Error("LLM cannot be disabled when inspection is required");
  }

  if (repoUninitialized) {
    // Use LLM to plan from scratch even for empty repos
    console.log("\n[Planner] Repository is not initialized. Using LLM to plan from scratch.");
    // Skip inspection but treat all as unimplemented
    const emptyInspection: CodebaseInspection = {
      summary: "The repository is empty, so all requirements are currently unimplemented.",
      satisfied: [],
      gaps: requirement.acceptanceCriteria.map((c) => `Not implemented: ${c}`),
      evidence: [],
      notes: ["No files exist in the repository, so all required artifacts must be created."],
    };
    inspectionResult = emptyInspection;
    inspectionNotes = formatInspectionNotes(emptyInspection);
    requirement = attachInspectionToRequirement(requirement, inspectionNotes);
  } else {
    if (!config.inspectCodebase) {
      console.log("[Planner] Enabling inspection (required).");
    }
    const inspectionTimeout = config.inspectionTimeoutSeconds;
    console.log(`\n[Planner] Inspecting codebase with LLM... (timeout: ${inspectionTimeout}s)`);
    // Log elapsed time periodically to avoid appearing unresponsive during LLM wait
    const inspectionStart = Date.now();
    const inspectionHeartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - inspectionStart) / 1000);
      console.log(`[Planner] Inspection in progress... (${elapsed}s elapsed)`);
    }, 30000);
    let inspection: CodebaseInspection | undefined;
    try {
      inspection = await inspectCodebase(requirement, {
        workdir: config.workdir,
        timeoutSeconds: inspectionTimeout,
      });
    } finally {
      clearInterval(inspectionHeartbeat);
      const elapsed = Math.round((Date.now() - inspectionStart) / 1000);
      console.log(`[Planner] Inspection finished in ${elapsed}s`);
    }
    if (!inspection) {
      console.warn("[Planner] Inspection failed; continuing in no-inspection mode.");
      const inspectionUnavailableNote = [
        "Codebase Inspection:",
        "Summary: Inspection could not be completed.",
        "Notes:",
        "- To avoid halting Planner due to LLM quota/timeout, fallback planning was used.",
      ].join("\n");
      inspectionNotes = inspectionUnavailableNote;
      requirement = attachInspectionToRequirement(requirement, inspectionUnavailableNote);
    } else {
      inspectionResult = inspection;
      inspectionNotes = formatInspectionNotes(inspection);
      requirement = attachInspectionToRequirement(requirement, inspectionNotes);
    }
  }

  // Generate tasks
  let result: TaskGenerationResult;

  const canUseLlmPlanning = config.useLlm && (repoUninitialized || Boolean(inspectionResult));
  if (config.useLlm && !canUseLlmPlanning) {
    console.warn(
      "[Planner] No inspection result; skipping LLM planning and using simple fallback.",
    );
  }

  if (canUseLlmPlanning) {
    console.log(`\n[Generating tasks with LLM...] (timeout: ${config.timeoutSeconds}s)`);
    const genStart = Date.now();
    const genHeartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - genStart) / 1000);
      console.log(`[Planner] Task generation in progress... (${elapsed}s elapsed)`);
    }, 30000);
    try {
      try {
        result = await generateTasksFromRequirement(requirement, {
          workdir: config.workdir,
          instructionsPath: config.instructionsPath,
          timeoutSeconds: config.timeoutSeconds,
          inspection: inspectionResult,
        });
      } catch (error) {
        const message = clipText(getErrorMessage(error), 220);
        if (isTaskParseFailure(message)) {
          throw error;
        }
        console.warn(`[Planner] LLM task generation failed: ${message}`);
        result = appendPlannerWarning(
          generateSimpleTasks(requirement),
          `LLM task generation failed; fallback used: ${message}`,
        );
      }
    } finally {
      clearInterval(genHeartbeat);
      const elapsed = Math.round((Date.now() - genStart) / 1000);
      console.log(`[Planner] Task generation finished in ${elapsed}s`);
    }
  } else {
    console.log("\n[Generating tasks without LLM (fallback mode)...]");
    result = appendPlannerWarning(
      generateSimpleTasks(requirement),
      "LLM planning skipped because inspection was unavailable.",
    );
  }

  result = ensureInitializationTaskForUninitializedRepo(result, requirement, repoUninitialized);

  const docGap = !repoUninitialized ? await detectDocGap(config.workdir) : undefined;
  if (docGap?.hasGap && !(await hasPendingDocserTask())) {
    const dependsOnIndexes = result.tasks.map((_, index) => index);
    const docserTask = buildDocserTaskForGap({
      requirement,
      docGap,
      checkCommand,
      dependsOnIndexes,
    });
    result = {
      ...result,
      tasks: [...result.tasks, docserTask],
      warnings: [...result.warnings, "Added docser task for undocumented code."],
    };
  }

  result = await applyPlannerTaskPolicies({
    result,
    requirement,
    workdir: config.workdir,
    checkScriptAvailable,
    e2eCommand,
    devCommand,
    judgeFeedback,
    inspectionNotes,
    policyRecoveryHints,
  });

  if (requirementCompletion.completionApplied) {
    const requirementSyncTask = buildRequirementSyncTask({
      requirement,
      checkCommand,
    });
    result = injectRequirementSyncTask(result, requirementSyncTask);
  }

  // Log results
  console.log(`\n[Generated ${result.tasks.length} tasks]`);
  console.log(`Total estimated time: ${result.totalEstimatedMinutes} minutes`);

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  console.log("\nTasks:");
  for (let i = 0; i < result.tasks.length; i++) {
    const task = result.tasks[i];
    if (!task) continue;
    console.log(`  ${i + 1}. ${task.title}`);
    console.log(`     Goal: ${task.goal.slice(0, 80)}${task.goal.length > 80 ? "..." : ""}`);
    console.log(
      `     Priority: ${task.priority}, Risk: ${task.riskLevel}, Time: ${task.timeboxMinutes}min`,
    );
  }

  // Skip save on dry run
  if (config.dryRun) {
    console.log("\n[Dry run mode - tasks not saved]");
    return;
  }

  const planSignature = await computePlanSignature({
    requirementPath,
    workdir: config.workdir,
    repoUrl: config.repoUrl,
    baseBranch: config.baseBranch,
  });

  const dedupeWindowMs = resolvePlanDedupeWindowMs();
  const holdTasksForIssueLinking = canUseGitHubIssueLinking();
  if (planSignature?.signature) {
    let skippedReason: "in_progress" | "recent" | null = null;
    let savedIdsInTx: string[] = [];

    await db.transaction(async (tx) => {
      const database = tx as unknown as typeof db;
      const acquired = await tryAcquirePlanSaveLock(planSignature.signature, database);
      if (!acquired) {
        skippedReason = "in_progress";
        return;
      }

      if (await wasPlanRecentlyCreated(planSignature.signature, dedupeWindowMs, database)) {
        skippedReason = "recent";
        return;
      }

      // Persist to DB
      console.log("\n[Saving tasks to database...]");
      const savedIds = await saveTasks(result.tasks, database, {
        initialStateResolver: (input) => {
          if (holdTasksForIssueLinking && !input.context?.issue?.number) {
            return { status: "blocked", blockReason: "issue_linking" };
          }
          return { status: "queued", blockReason: null };
        },
      });
      await resolveDependencies(savedIds, result.tasks, database);

      // Record plan for UI reference
      await recordPlannerPlanEvent({
        requirementPath,
        requirement,
        result,
        savedIds,
        agentId,
        signature: planSignature,
        database,
      });

      savedIdsInTx = savedIds;
    });

    if (skippedReason === "in_progress") {
      console.log("\n[Planner] Plan with same signature is being saved; skipping duplicate.");
      return;
    }
    if (skippedReason === "recent") {
      console.log("\n[Planner] Plan with same signature was saved recently; skipping duplicate.");
      return;
    }
    if (savedIdsInTx.length === 0) {
      if (result.tasks.length === 0) {
        console.log("\n[Planner] No additional tasks needed (no requirement gaps).");
      } else {
        console.warn("\n[Planner] Plan was not saved due to an unknown dedupe condition.");
      }
      return;
    }

    await createIssuesForTasks({
      requirement,
      tasks: result.tasks,
      savedIds: savedIdsInTx,
    });

    console.log(`\nSaved ${savedIdsInTx.length} tasks to database`);
    console.log("Task IDs:");
    for (const id of savedIdsInTx) {
      console.log(`  - ${id}`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("Planning complete!");
    console.log("=".repeat(60));
    return;
  }

  // Persist to DB
  console.log("\n[Saving tasks to database...]");
  const savedIds = await saveTasks(result.tasks, db, {
    initialStateResolver: (input) => {
      if (holdTasksForIssueLinking && !input.context?.issue?.number) {
        return { status: "blocked", blockReason: "issue_linking" };
      }
      return { status: "queued", blockReason: null };
    },
  });
  await resolveDependencies(savedIds, result.tasks);

  // Record plan for UI reference
  await recordPlannerPlanEvent({
    requirementPath,
    requirement,
    result,
    savedIds,
    agentId,
    signature: planSignature,
  });

  await createIssuesForTasks({
    requirement,
    tasks: result.tasks,
    savedIds,
  });

  console.log(`\nSaved ${savedIds.length} tasks to database`);
  console.log("Task IDs:");
  for (const id of savedIds) {
    console.log(`  - ${id}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Planning complete!");
  console.log("=".repeat(60));
}

// Generate tasks directly from requirement text (API use)
export async function planFromContent(
  content: string,
  config: Partial<PlannerConfig> = {},
): Promise<TaskGenerationResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  let requirement = parseRequirementContent(content);
  const requirementCompletion = await enrichRequirementIfMissing({
    requirement,
    useLlm: fullConfig.useLlm,
    workdir: fullConfig.workdir,
    timeoutSeconds: fullConfig.timeoutSeconds,
  });
  requirement = requirementCompletion.requirement;

  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(", ")}`);
  }

  await loadTaskPolicyOverridesFromRepo(fullConfig.workdir);

  const judgeFeedback = await loadJudgeFeedback();
  requirement = attachJudgeFeedbackToRequirement(requirement, judgeFeedback);
  const existingTaskHints = await loadExistingTaskHints();
  requirement = attachExistingTasksToRequirement(requirement, existingTaskHints);
  const policyRecoveryHints = await loadPolicyRecoveryPathHints();
  requirement = attachPolicyRecoveryHintsToRequirement(requirement, policyRecoveryHints);
  const checkScriptAvailable = await hasRootCheckScript(fullConfig.workdir);
  const devCommand = await resolveDevVerificationCommand(fullConfig.workdir);
  const checkCommand = await resolveCheckVerificationCommand(fullConfig.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(fullConfig.workdir);
  const repoUninitialized = await isRepoUninitialized(fullConfig.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;
  const applyRequirementSyncTaskIfNeeded = (result: TaskGenerationResult): TaskGenerationResult => {
    if (!requirementCompletion.completionApplied) {
      return result;
    }
    const requirementSyncTask = buildRequirementSyncTask({
      requirement,
      checkCommand,
    });
    return injectRequirementSyncTask(result, requirementSyncTask);
  };

  if (!repoUninitialized && !fullConfig.useLlm) {
    throw new Error("Inspection is required; LLM cannot be disabled.");
  }

  if (!repoUninitialized) {
    if (!fullConfig.inspectCodebase) {
      console.log("[Planner] Enabling inspection (required).");
    }
    const inspection = await inspectCodebase(requirement, {
      workdir: fullConfig.workdir,
      timeoutSeconds: fullConfig.inspectionTimeoutSeconds,
    });
    if (!inspection) {
      console.warn("[Planner] Inspection failed; continuing in no-inspection mode.");
      const inspectionUnavailableNote = [
        "Codebase Inspection:",
        "Summary: Inspection could not be completed.",
        "Notes:",
        "- To avoid halting Planner due to LLM quota/timeout, fallback planning was used.",
      ].join("\n");
      inspectionNotes = inspectionUnavailableNote;
      requirement = attachInspectionToRequirement(requirement, inspectionUnavailableNote);
    } else {
      inspectionResult = inspection;
      inspectionNotes = formatInspectionNotes(inspection);
      requirement = attachInspectionToRequirement(requirement, inspectionNotes);
    }
  }

  if (repoUninitialized) {
    const initializationResult = await applyPlannerTaskPolicies({
      result: generateInitializationTasks(requirement),
      requirement,
      workdir: fullConfig.workdir,
      checkScriptAvailable,
      e2eCommand,
      devCommand,
      judgeFeedback,
      inspectionNotes,
      policyRecoveryHints,
    });
    return applyRequirementSyncTaskIfNeeded(initializationResult);
  }

  const canUseLlmPlanning = fullConfig.useLlm && (repoUninitialized || Boolean(inspectionResult));

  if (fullConfig.useLlm && !canUseLlmPlanning) {
    console.warn(
      "[Planner] No inspection result; skipping LLM planning and using simple fallback.",
    );
  }

  if (canUseLlmPlanning) {
    let result: TaskGenerationResult;
    try {
      result = await generateTasksFromRequirement(requirement, {
        workdir: fullConfig.workdir,
        instructionsPath: fullConfig.instructionsPath,
        timeoutSeconds: fullConfig.timeoutSeconds,
        inspection: inspectionResult,
      });
    } catch (error) {
      const message = clipText(getErrorMessage(error), 220);
      if (isTaskParseFailure(message)) {
        throw error;
      }
      console.warn(`[Planner] LLM task generation failed: ${message}`);
      result = appendPlannerWarning(
        generateSimpleTasks(requirement),
        `LLM task generation failed; fallback used: ${message}`,
      );
    }
    const docGap = !repoUninitialized ? await detectDocGap(fullConfig.workdir) : undefined;
    if (docGap?.hasGap && !(await hasPendingDocserTask())) {
      const dependsOnIndexes = result.tasks.map((_, index) => index);
      const docserTask = buildDocserTaskForGap({
        requirement,
        docGap,
        checkCommand,
        dependsOnIndexes,
      });
      result = {
        ...result,
        tasks: [...result.tasks, docserTask],
        warnings: [...result.warnings, "Added docser task for undocumented code."],
      };
    }
    const plannedResult = await applyPlannerTaskPolicies({
      result,
      requirement,
      workdir: fullConfig.workdir,
      checkScriptAvailable,
      e2eCommand,
      devCommand,
      judgeFeedback,
      inspectionNotes,
      policyRecoveryHints,
    });
    return applyRequirementSyncTaskIfNeeded(plannedResult);
  }

  const fallbackResult = await applyPlannerTaskPolicies({
    result: appendPlannerWarning(
      generateSimpleTasks(requirement),
      "LLM planning skipped because inspection was unavailable.",
    ),
    requirement,
    workdir: fullConfig.workdir,
    checkScriptAvailable,
    e2eCommand,
    devCommand,
    judgeFeedback,
    inspectionNotes,
    policyRecoveryHints,
  });
  return applyRequirementSyncTaskIfNeeded(fallbackResult);
}
