import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@h1ve/db";
import { tasks } from "@h1ve/db/schema";
import type { CreateTaskInput } from "@h1ve/core";

import {
  parseRequirementFile,
  parseRequirementContent,
  validateRequirement,
  type Requirement,
} from "./parser.js";
import {
  generateTasksFromRequirement,
  generateSimpleTasks,
  type TaskGenerationResult,
} from "./strategies/index.js";

// Plannerの設定
interface PlannerConfig {
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  dryRun: boolean;
  timeoutSeconds: number;
}

// デフォルト設定
const DEFAULT_CONFIG: PlannerConfig = {
  workdir: process.cwd(),
  instructionsPath: resolve(
    import.meta.dirname,
    "../instructions/planning.md"
  ),
  useLlm: process.env.USE_LLM !== "false",
  dryRun: process.env.DRY_RUN === "true",
  timeoutSeconds: parseInt(process.env.PLANNER_TIMEOUT ?? "300", 10),
};

// タスクをDBに保存
async function saveTasks(taskInputs: CreateTaskInput[]): Promise<string[]> {
  const savedIds: string[] = [];

  for (const input of taskInputs) {
    const result = await db
      .insert(tasks)
      .values({
        title: input.title,
        goal: input.goal,
        context: input.context,
        allowedPaths: input.allowedPaths,
        commands: input.commands,
        priority: input.priority ?? 0,
        riskLevel: input.riskLevel ?? "low",
        dependencies: input.dependencies ?? [],
        timeboxMinutes: input.timeboxMinutes ?? 60,
      })
      .returning({ id: tasks.id });

    const saved = result[0];
    if (saved) {
      savedIds.push(saved.id);
    }
  }

  return savedIds;
}

// 依存関係を解決してDBのIDで更新
async function resolveDependencies(
  savedIds: string[],
  originalTasks: CreateTaskInput[]
): Promise<void> {
  // 元のタスクにdependsOnがあった場合、インデックスからIDに変換
  for (let i = 0; i < originalTasks.length; i++) {
    const original = originalTasks[i];
    const savedId = savedIds[i];
    
    if (!original || !savedId) continue;

    // dependenciesがインデックス参照だった場合の処理
    // 現時点では依存関係は空で作成し、後で手動設定を想定
  }
}

// 要件ファイルからタスクを生成
async function planFromRequirement(
  requirementPath: string,
  config: PlannerConfig
): Promise<void> {
  console.log("=".repeat(60));
  console.log("h1ve Planner - Task Generation");
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
    console.error(`Failed to read requirement file: ${error}`);
    process.exit(1);
  }

  // 要件を検証
  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    console.error("Validation errors:");
    for (const error of validationErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("\n[Parsed Requirement]");
  console.log(`Goal: ${requirement.goal}`);
  console.log(`Acceptance Criteria: ${requirement.acceptanceCriteria.length} items`);
  console.log(`Allowed Paths: ${requirement.allowedPaths.join(", ")}`);

  // タスクを生成
  let result: TaskGenerationResult;

  if (config.useLlm) {
    console.log("\n[Generating tasks with LLM...]");
    try {
      result = await generateTasksFromRequirement(requirement, {
        workdir: config.workdir,
        instructionsPath: config.instructionsPath,
        timeoutSeconds: config.timeoutSeconds,
      });
    } catch (error) {
      console.warn(`LLM generation failed: ${error}`);
      console.log("Falling back to simple generation...");
      result = generateSimpleTasks(requirement);
    }
  } else {
    console.log("\n[Generating tasks without LLM...]");
    result = generateSimpleTasks(requirement);
  }

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
    console.log(`     Priority: ${task.priority}, Risk: ${task.riskLevel}, Time: ${task.timeboxMinutes}min`);
  }

  // Dry runの場合は保存しない
  if (config.dryRun) {
    console.log("\n[Dry run mode - tasks not saved]");
    return;
  }

  // DBに保存
  console.log("\n[Saving tasks to database...]");
  const savedIds = await saveTasks(result.tasks);
  await resolveDependencies(savedIds, result.tasks);

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
  config: Partial<PlannerConfig> = {}
): Promise<TaskGenerationResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const requirement = parseRequirementContent(content);

  const validationErrors = validateRequirement(requirement);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(", ")}`);
  }

  if (fullConfig.useLlm) {
    try {
      return await generateTasksFromRequirement(requirement, {
        workdir: fullConfig.workdir,
        instructionsPath: fullConfig.instructionsPath,
        timeoutSeconds: fullConfig.timeoutSeconds,
      });
    } catch {
      return generateSimpleTasks(requirement);
    }
  }

  return generateSimpleTasks(requirement);
}

// ヘルプを表示
function showHelp(): void {
  console.log(`
h1ve Planner - Generate tasks from requirements

Usage:
  pnpm --filter @h1ve/planner start <requirement.md>
  pnpm --filter @h1ve/planner start --help

Options:
  --help          Show this help message
  --dry-run       Generate tasks but don't save to database
  --no-llm        Skip LLM and use simple generation

Environment Variables:
  USE_LLM=false         Disable LLM generation
  DRY_RUN=true          Enable dry run mode
  PLANNER_TIMEOUT=300   LLM timeout in seconds

Example:
  pnpm --filter @h1ve/planner start docs/requirements/feature-x.md
`);
}

// メイン処理
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ヘルプ
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // 設定を構築
  const config = { ...DEFAULT_CONFIG };

  if (args.includes("--dry-run")) {
    config.dryRun = true;
  }

  if (args.includes("--no-llm")) {
    config.useLlm = false;
  }

  // 要件ファイルパスを取得
  const requirementPath = args.find((arg) => !arg.startsWith("--"));

  if (!requirementPath) {
    console.error("Error: Requirement file path is required");
    showHelp();
    process.exit(1);
  }

  // ファイルの存在確認
  try {
    await stat(requirementPath);
  } catch {
    console.error(`Error: File not found: ${requirementPath}`);
    process.exit(1);
  }

  // 実行
  await planFromRequirement(resolve(requirementPath), config);
}

main().catch((error) => {
  console.error("Planner crashed:", error);
  process.exit(1);
});
