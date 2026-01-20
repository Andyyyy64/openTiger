import { db } from "@h1ve/db";
import { tasks } from "@h1ve/db/schema";
import type { CreateTaskInput } from "@h1ve/core";

// Planner: 要件からタスクを生成・分割する
// 入力: requirement.md（人間が書く）
// 出力: tasks[]（DBに保存）

interface Requirement {
  goal: string;
  background?: string;
  constraints: string[];
  acceptanceCriteria: string[];
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  allowedPaths: string[];
  riskAssessment?: string;
  notes?: string;
}

interface PlanningResult {
  tasks: CreateTaskInput[];
  warnings: string[];
}

async function parseRequirement(content: string): Promise<Requirement> {
  // TODO: LLMを使って要件をパース
  // 現時点ではダミー実装
  return {
    goal: "Sample goal",
    constraints: [],
    acceptanceCriteria: [],
    scope: {
      inScope: [],
      outOfScope: [],
    },
    allowedPaths: ["**/*"],
  };
}

async function generateTasks(requirement: Requirement): Promise<PlanningResult> {
  // TODO: LLMを使ってタスクを生成
  // 分割ルール:
  // - 1タスク = 30〜90分で完了
  // - テストで成功判定可能
  // - 依存関係を明示
  // - 変更範囲を限定

  const tasks: CreateTaskInput[] = [
    {
      title: "Sample task 1",
      goal: requirement.goal,
      allowedPaths: requirement.allowedPaths,
      commands: ["pnpm test"],
      priority: 10,
      riskLevel: "low",
      timeboxMinutes: 60,
    },
  ];

  return {
    tasks,
    warnings: [],
  };
}

async function saveTasks(taskInputs: CreateTaskInput[]): Promise<void> {
  for (const input of taskInputs) {
    await db.insert(tasks).values({
      title: input.title,
      goal: input.goal,
      context: input.context,
      allowedPaths: input.allowedPaths,
      commands: input.commands,
      priority: input.priority ?? 0,
      riskLevel: input.riskLevel ?? "low",
      dependencies: input.dependencies ?? [],
      timeboxMinutes: input.timeboxMinutes ?? 60,
    });
  }
}

async function plan(requirementPath: string): Promise<void> {
  console.log(`Planning from: ${requirementPath}`);

  // TODO: ファイルを読み込む
  const content = ""; // fs.readFileSync(requirementPath, 'utf-8')

  const requirement = await parseRequirement(content);
  const result = await generateTasks(requirement);

  if (result.warnings.length > 0) {
    console.warn("Warnings:");
    for (const warning of result.warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  console.log(`Generated ${result.tasks.length} tasks`);

  await saveTasks(result.tasks);
  console.log("Tasks saved to database");
}

// メイン処理
async function main() {
  console.log("Planner started");

  // TODO: 引数から要件ファイルパスを受け取る
  // await plan(process.argv[2]);
}

main().catch(console.error);
