import { runClaudeCode } from "@h1ve/llm";
import type { CreateTaskInput } from "@h1ve/core";
import type { Requirement } from "../parser.js";

// タスク生成結果
export interface TaskGenerationResult {
  tasks: CreateTaskInput[];
  warnings: string[];
  totalEstimatedMinutes: number;
}

// LLMに渡すプロンプトを構築
function buildPrompt(requirement: Requirement): string {
  return `
あなたはソフトウェアエンジニアリングのタスク分割エキスパートです。
以下の要件定義を読み取り、実行可能なタスクに分割してください。

## タスク分割の原則

1. **粒度**: 1タスク = 30〜90分で完了できるサイズ
2. **判定可能**: テストやコマンドで成功/失敗を判定できる
3. **独立性**: 可能な限り他のタスクに依存しない
4. **範囲限定**: 変更するファイル/ディレクトリを明確にする

## 要件定義

### Goal
${requirement.goal}

### Background
${requirement.background || "(なし)"}

### Constraints
${requirement.constraints.length > 0 ? requirement.constraints.map(c => `- ${c}`).join("\n") : "(なし)"}

### Acceptance Criteria
${requirement.acceptanceCriteria.map(c => `- ${c}`).join("\n")}

### Scope
#### In Scope
${requirement.scope.inScope.map(s => `- ${s}`).join("\n") || "(なし)"}

#### Out of Scope
${requirement.scope.outOfScope.map(s => `- ${s}`).join("\n") || "(なし)"}

### Allowed Paths
${requirement.allowedPaths.map(p => `- ${p}`).join("\n")}

### Risk Assessment
${requirement.riskAssessment.length > 0 
  ? requirement.riskAssessment.map(r => `- ${r.risk} (${r.impact}): ${r.mitigation}`).join("\n")
  : "(なし)"}

### Notes
${requirement.notes || "(なし)"}

## 出力形式

以下のJSON形式で出力してください。他のテキストは出力しないでください。

\`\`\`json
{
  "tasks": [
    {
      "title": "簡潔なタスク名",
      "goal": "機械判定可能な完了条件（テストが通る、コマンドが成功する等）",
      "context": {
        "files": ["関連ファイルパス"],
        "specs": "詳細仕様",
        "notes": "補足情報"
      },
      "allowedPaths": ["変更許可パス（glob）"],
      "commands": ["検証コマンド（pnpm test等）"],
      "priority": 10,
      "riskLevel": "low",
      "dependsOn": [],
      "timeboxMinutes": 60
    }
  ],
  "warnings": ["警告メッセージ"]
}
\`\`\`

## 注意事項

- タスクは実行順序を考慮し、dependsOnで依存関係を明示（インデックスで参照）
- 各タスクのcommandは必ず成功/失敗を返すもの
- riskLevelは "low" / "medium" / "high" のいずれか
- timeboxMinutesは30〜90の範囲で
- 曖昧なゴール（「改善する」等）は避ける
`.trim();
}

// LLMレスポンスからJSONを抽出
function extractJsonFromResponse(response: string): unknown {
  // コードブロックを探す
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const codeBlockContent = codeBlockMatch?.[1];
  if (codeBlockContent) {
    return JSON.parse(codeBlockContent.trim());
  }

  // 直接JSONを試す
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const jsonContent = jsonMatch?.[0];
  if (jsonContent) {
    return JSON.parse(jsonContent);
  }

  throw new Error("No valid JSON found in response");
}

// 依存関係をインデックスからタスクIDへの参照に変換
function resolveDependencies(
  tasks: Array<{
    title: string;
    goal: string;
    context?: { files?: string[]; specs?: string; notes?: string };
    allowedPaths: string[];
    commands: string[];
    priority?: number;
    riskLevel?: string;
    dependsOn?: number[];
    timeboxMinutes?: number;
  }>
): CreateTaskInput[] {
  // 一旦全タスクを生成（依存関係は後で解決）
  const taskInputs: CreateTaskInput[] = tasks.map((task, index) => ({
    title: task.title,
    goal: task.goal,
    context: task.context,
    allowedPaths: task.allowedPaths,
    commands: task.commands,
    priority: task.priority ?? (tasks.length - index) * 10, // 順序から優先度を設定
    riskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
    dependencies: [], // 後で設定
    timeboxMinutes: task.timeboxMinutes ?? 60,
  }));

  return taskInputs;
}

// 要件からタスクを生成
export async function generateTasksFromRequirement(
  requirement: Requirement,
  options: {
    workdir: string;
    instructionsPath?: string;
    timeoutSeconds?: number;
  }
): Promise<TaskGenerationResult> {
  const prompt = buildPrompt(requirement);

  // Claude Codeを実行
  const result = await runClaudeCode({
    workdir: options.workdir,
    instructionsPath: options.instructionsPath,
    task: prompt,
    timeoutSeconds: options.timeoutSeconds ?? 300,
  });

  if (!result.success) {
    throw new Error(`Claude Code failed: ${result.stderr}`);
  }

  // レスポンスをパース
  let parsed: {
    tasks: Array<{
      title: string;
      goal: string;
      context?: { files?: string[]; specs?: string; notes?: string };
      allowedPaths: string[];
      commands: string[];
      priority?: number;
      riskLevel?: string;
      dependsOn?: number[];
      timeboxMinutes?: number;
    }>;
    warnings?: string[];
  };

  try {
    parsed = extractJsonFromResponse(result.stdout) as typeof parsed;
  } catch (error) {
    throw new Error(`Failed to parse LLM response: ${error}`);
  }

  // タスクを変換
  const tasks = resolveDependencies(parsed.tasks);

  // 合計見積もり時間
  const totalEstimatedMinutes = tasks.reduce(
    (sum, t) => sum + (t.timeboxMinutes ?? 60),
    0
  );

  return {
    tasks,
    warnings: parsed.warnings ?? [],
    totalEstimatedMinutes,
  };
}

// タスクをLLMなしでシンプルに生成（フォールバック用）
export function generateSimpleTasks(requirement: Requirement): TaskGenerationResult {
  const tasks: CreateTaskInput[] = [];

  // 受け入れ条件からタスクを生成
  requirement.acceptanceCriteria.forEach((criterion, index) => {
    tasks.push({
      title: `Implement: ${criterion.slice(0, 50)}${criterion.length > 50 ? "..." : ""}`,
      goal: criterion,
      context: {
        specs: requirement.goal,
        notes: requirement.notes,
      },
      allowedPaths: requirement.allowedPaths,
      commands: ["pnpm test", "pnpm run check"],
      priority: (requirement.acceptanceCriteria.length - index) * 10,
      riskLevel: determineRiskLevel(requirement),
      dependencies: [],
      timeboxMinutes: 60,
    });
  });

  return {
    tasks,
    warnings: ["Tasks were generated without LLM analysis. Manual review recommended."],
    totalEstimatedMinutes: tasks.length * 60,
  };
}

// リスクレベルを判定
function determineRiskLevel(requirement: Requirement): "low" | "medium" | "high" {
  // 高リスクの項目があれば全体も高リスク
  if (requirement.riskAssessment.some(r => r.impact === "high")) {
    return "high";
  }
  if (requirement.riskAssessment.some(r => r.impact === "medium")) {
    return "medium";
  }
  return "low";
}
