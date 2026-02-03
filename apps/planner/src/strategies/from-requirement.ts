import { runOpenCode } from "@sebastian-code/llm";
import type { CreateTaskInput } from "@sebastian-code/core";
import type { Requirement } from "../parser.js";
import { PLANNER_OPENCODE_CONFIG_PATH } from "../opencode-config.js";

// タスク生成結果
export interface PlannedTaskInput extends CreateTaskInput {
  dependsOnIndexes?: number[]; // LLMの依存関係インデックスを保持して後で解決する
}

export interface TaskGenerationResult {
  tasks: PlannedTaskInput[];
  warnings: string[];
  totalEstimatedMinutes: number;
}

// LLMに渡すプロンプトを構築
function buildPrompt(requirement: Requirement): string {
  return `
あなたはソフトウェアエンジニアリングのタスク分割エキスパートです。
以下の要件定義を読み取り、実行可能なタスクに分割してください。
ツール呼び出しは禁止です。与えられた情報だけで判断してください。

## タスク分割の原則

1. **粒度**: 1タスク = 30〜90分で完了できるサイズ
2. **判定可能**: テストやコマンドで成功/失敗を判定できる
3. **独立性**: 可能な限り他のタスクに依存しない
4. **範囲限定**: 変更するファイル/ディレクトリを明確にする
5. **既存構成遵守**: 既存のモノレポ構成と技術スタックを必ず守る
6. **許可パス遵守**: allowedPaths の外に触る必要があるタスクは作らない
7. **役割分担**: 実装は worker、テスト作成/追加は tester に割り当てる

## 既存構成と技術スタックの厳守

- 既存のディレクトリ構成（apps/ と packages/）を前提にする
- 既存の採用技術を尊重し、要件の技術スタックに従う
- 要件にない新規ツールやフレームワークを持ち込まない
- 新規アプリ追加は要件に明示がある場合のみ

## allowedPaths の扱い

- allowedPaths 外の変更が必要ならタスクを作らず warnings に理由を書く
- 依存関係の追加やルート変更が必要なら「依存関係タスク」に分離する
- 依存関係タスクの allowedPaths にはルートの必要ファイルを含める

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
      "role": "worker or tester",
      "context": {
        "files": ["関連ファイルパス"],
        "specs": "詳細仕様",
        "notes": "補足情報"
      },
      "allowedPaths": ["変更許可パス（glob）"],
      "commands": ["検証コマンド（pnpm test / pnpm run dev など）"],
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
- 検証コマンドは必ず成功/失敗を返し、dev起動の確認も含める
- フロントが絡むタスクはE2Eを必須とし、クリティカルパスを最低限カバーする
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
    role?: string;
    context?: { files?: string[]; specs?: string; notes?: string };
    allowedPaths: string[];
    commands: string[];
    priority?: number;
    riskLevel?: string;
    dependsOn?: number[];
    timeboxMinutes?: number;
  }>
): PlannedTaskInput[] {
  // 一旦全タスクを生成（依存関係は後で解決）
  const taskInputs: PlannedTaskInput[] = tasks.map((task, index) => ({
    title: task.title,
    goal: task.goal,
    role: (task.role as "worker" | "tester" | undefined) ?? "worker",
    context: task.context,
    allowedPaths: task.allowedPaths,
    commands: task.commands,
    priority: task.priority ?? (tasks.length - index) * 10, // 順序から優先度を設定
    riskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
    dependencies: [], // 後で設定
    dependsOnIndexes: task.dependsOn?.filter((dep) => Number.isInteger(dep)) ?? [],
    timeboxMinutes: task.timeboxMinutes ?? 60,
    targetArea: undefined,
    touches: [],
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
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";

  // OpenCodeを実行
  const result = await runOpenCode({
    workdir: options.workdir,
    task: prompt,
    model: plannerModel, // Plannerは高精度モデルで計画品質を優先する
    timeoutSeconds: options.timeoutSeconds ?? 300,
    // Plannerはプロンプト内の情報だけで判断するためツールを使わない
    env: { OPENCODE_CONFIG: PLANNER_OPENCODE_CONFIG_PATH },
  });

  if (!result.success) {
    throw new Error(`OpenCode failed: ${result.stderr}`);
  }

  // レスポンスをパース
  let parsed: {
    tasks: Array<{
      title: string;
      goal: string;
      role?: string;
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
  const tasks: PlannedTaskInput[] = [];

  // 受け入れ条件からタスクを生成
  requirement.acceptanceCriteria.forEach((criterion, index) => {
    tasks.push({
      title: `Implement: ${criterion.slice(0, 50)}${criterion.length > 50 ? "..." : ""}`,
      goal: criterion,
      role: "worker",
      context: {
        specs: requirement.goal,
        notes: requirement.notes,
      },
      allowedPaths: requirement.allowedPaths,
      commands: ["pnpm test", "pnpm run check", "pnpm run dev"],
      priority: (requirement.acceptanceCriteria.length - index) * 10,
      riskLevel: determineRiskLevel(requirement),
      dependencies: [],
      dependsOnIndexes: [],
      timeboxMinutes: 60,
      targetArea: undefined,
      touches: [],
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
