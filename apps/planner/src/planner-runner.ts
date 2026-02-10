import { db } from "@openTiger/db";
import { getRepoMode } from "@openTiger/core";
import {
  parseRequirementFile,
  parseRequirementContent,
  validateRequirement,
  type Requirement,
} from "./parser";
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
  applyVerificationCommandPolicy,
  applyTesterCommandPolicy,
  applyDevCommandPolicy,
  generateInitializationTasks,
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
  loadExistingTaskHints,
  loadJudgeFeedback,
} from "./planner-notes";
import { clipText, getErrorMessage, isRepoUninitialized } from "./planner-utils";
import { augmentVerificationCommandsForTasks } from "./planner-verification";
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

function isTaskParseFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to parse llm response") ||
    normalized.includes("no valid json found in response") ||
    (normalized.includes("json") && normalized.includes("parse"))
  );
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
  next = attachJudgeFeedbackToTasks(next, params.judgeFeedback);
  next = attachInspectionToTasks(next, params.inspectionNotes);
  return next;
}

// 要件ファイルからタスクを生成
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

  // 要件ファイルを読み込み
  let requirement: Requirement;
  try {
    requirement = await parseRequirementFile(requirementPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read requirement file: ${message}`);
  }

  // 要件を検証
  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    console.error("Validation errors:");
    for (const error of validationErrors) {
      console.error(`  - ${error}`);
    }
    throw new Error("Validation failed");
  }

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
  const checkScriptAvailable = await hasRootCheckScript(config.workdir);
  if (!checkScriptAvailable) {
    console.log("[Planner] checkスクリプトがないため検証コマンドを調整します。");
  }
  const devCommand = await resolveDevVerificationCommand(config.workdir);
  const checkCommand = await resolveCheckVerificationCommand(config.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(config.workdir);
  const repoUninitialized = await isRepoUninitialized(config.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;

  if (!repoUninitialized && !config.useLlm) {
    console.error("[Planner] 差分点検が必須のため、LLMを無効化できません。");
    throw new Error("LLM cannot be disabled when inspection is required");
  }

  if (repoUninitialized) {
    // 空リポジトリでも要件に基づいてLLMにタスクを分割させる
    console.log("\n[Planner] Repository is not initialized. Using LLM to plan from scratch.");
    // 差分点検は不要だが「すべてが未実装」と明示する
    const emptyInspection: CodebaseInspection = {
      summary: "リポジトリが空のため、要件のすべてが未実装です。",
      satisfied: [],
      gaps: requirement.acceptanceCriteria.map((c) => `未実装: ${c}`),
      evidence: [],
      notes: ["リポジトリにはファイルが存在しないため、すべてを新規作成する必要があります。"],
    };
    inspectionResult = emptyInspection;
    inspectionNotes = formatInspectionNotes(emptyInspection);
    requirement = attachInspectionToRequirement(requirement, inspectionNotes);
  } else {
    if (!config.inspectCodebase) {
      console.log("[Planner] 差分点検は必須のため有効化します。");
    }
    const inspectionTimeout = config.inspectionTimeoutSeconds;
    console.log(`\n[Planner] Inspecting codebase with LLM... (timeout: ${inspectionTimeout}s)`);
    // LLM応答待ちで無応答に見えるのを避けるため、経過時間を定期的にログに出す
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
      console.warn("[Planner] 差分点検に失敗したため、点検なしモードで続行します。");
      const inspectionUnavailableNote = [
        "コードベース差分点検:",
        "概要: 差分点検が失敗したため未実施",
        "補足:",
        "- LLMクォータ/タイムアウト時でもPlannerを停止しないため、簡易計画へフォールバックします。",
      ].join("\n");
      inspectionNotes = inspectionUnavailableNote;
      requirement = attachInspectionToRequirement(requirement, inspectionUnavailableNote);
    } else {
      inspectionResult = inspection;
      inspectionNotes = formatInspectionNotes(inspection);
      requirement = attachInspectionToRequirement(requirement, inspectionNotes);
    }
  }

  // タスクを生成
  let result: TaskGenerationResult;

  const canUseLlmPlanning = config.useLlm && (repoUninitialized || Boolean(inspectionResult));
  if (config.useLlm && !canUseLlmPlanning) {
    console.warn(
      "[Planner] 差分点検結果がないためLLM計画をスキップし、簡易計画へフォールバックします。",
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
      warnings: [...result.warnings, "ドキュメントが未整備のためdocserタスクを追加しました。"],
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
  });

  // 結果を表示
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

  // Dry runの場合は保存しない
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
  const holdTasksForIssueLinking =
    getRepoMode() === "git" &&
    Boolean(process.env.GITHUB_TOKEN) &&
    Boolean(process.env.GITHUB_OWNER) &&
    Boolean(process.env.GITHUB_REPO);
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

      // DBに保存
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

      // Plannerの計画内容をUI側で参照できるように記録する
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
      console.log("\n[Planner] 同一署名のPlan保存が進行中のため、保存をスキップします。");
      return;
    }
    if (skippedReason === "recent") {
      console.log("\n[Planner] 同一署名のPlanが直近に作成済みのため、保存をスキップします。");
      return;
    }
    if (savedIdsInTx.length === 0) {
      if (result.tasks.length === 0) {
        console.log("\n[Planner] 追加タスクは不要です（要件ギャップなし）。");
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

  // DBに保存
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

  // Plannerの計画内容をUI側で参照できるように記録する
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

// 要件テキストから直接タスクを生成（API用）
export async function planFromContent(
  content: string,
  config: Partial<PlannerConfig> = {},
): Promise<TaskGenerationResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  let requirement = parseRequirementContent(content);

  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(", ")}`);
  }

  const judgeFeedback = await loadJudgeFeedback();
  requirement = attachJudgeFeedbackToRequirement(requirement, judgeFeedback);
  const existingTaskHints = await loadExistingTaskHints();
  requirement = attachExistingTasksToRequirement(requirement, existingTaskHints);
  const checkScriptAvailable = await hasRootCheckScript(fullConfig.workdir);
  const devCommand = await resolveDevVerificationCommand(fullConfig.workdir);
  const checkCommand = await resolveCheckVerificationCommand(fullConfig.workdir);
  const e2eCommand = await resolveE2EVerificationCommand(fullConfig.workdir);
  const repoUninitialized = await isRepoUninitialized(fullConfig.workdir);
  let inspectionNotes: string | undefined;
  let inspectionResult: CodebaseInspection | undefined;

  if (!repoUninitialized && !fullConfig.useLlm) {
    throw new Error("差分点検が必須のため、LLMを無効化できません。");
  }

  if (!repoUninitialized) {
    if (!fullConfig.inspectCodebase) {
      console.log("[Planner] 差分点検は必須のため有効化します。");
    }
    const inspection = await inspectCodebase(requirement, {
      workdir: fullConfig.workdir,
      timeoutSeconds: fullConfig.inspectionTimeoutSeconds,
    });
    if (!inspection) {
      console.warn("[Planner] 差分点検に失敗したため、点検なしモードで続行します。");
      const inspectionUnavailableNote = [
        "コードベース差分点検:",
        "概要: 差分点検が失敗したため未実施",
        "補足:",
        "- LLMクォータ/タイムアウト時でもPlannerを停止しないため、簡易計画へフォールバックします。",
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
    return applyPlannerTaskPolicies({
      result: generateInitializationTasks(requirement),
      requirement,
      workdir: fullConfig.workdir,
      checkScriptAvailable,
      e2eCommand,
      devCommand,
      judgeFeedback,
      inspectionNotes,
    });
  }

  const canUseLlmPlanning = fullConfig.useLlm && (repoUninitialized || Boolean(inspectionResult));
  if (fullConfig.useLlm && !canUseLlmPlanning) {
    console.warn(
      "[Planner] 差分点検結果がないためLLM計画をスキップし、簡易計画へフォールバックします。",
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
        warnings: [...result.warnings, "ドキュメントが未整備のためdocserタスクを追加しました。"],
      };
    }
    return applyPlannerTaskPolicies({
      result,
      requirement,
      workdir: fullConfig.workdir,
      checkScriptAvailable,
      e2eCommand,
      devCommand,
      judgeFeedback,
      inspectionNotes,
    });
  }

  return applyPlannerTaskPolicies({
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
  });
}
