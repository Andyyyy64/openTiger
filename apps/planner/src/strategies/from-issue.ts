import { runOpenCode } from "@sebastian-code/llm";
import type { CreateTaskInput } from "@sebastian-code/core";
import { PLANNER_OPENCODE_CONFIG_PATH } from "../opencode-config.js";

// GitHub Issue情報
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
}

// Issue解析結果
export interface IssueAnalysisResult {
  tasks: CreateTaskInput[];
  warnings: string[];
  issueNumber: number;
}

// IssueからLLMプロンプトを構築
function buildPromptFromIssue(issue: GitHubIssue, allowedPaths: string[]): string {
  return `
あなたはソフトウェアエンジニアリングのタスク分割エキスパートです。
以下のGitHub Issueを読み取り、実行可能なタスクに分割してください。
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
- 既存の採用技術を尊重し、Issueの前提に従う
- 要件にない新規ツールやフレームワークを持ち込まない
- 新規アプリ追加はIssueに明示がある場合のみ

## allowedPaths の扱い

- allowedPaths 外の変更が必要ならタスクを作らず warnings に理由を書く
- 依存関係の追加やルート変更が必要なら「依存関係タスク」に分離する
- 依存関係タスクの allowedPaths にはルートの必要ファイルを含める

## GitHub Issue #${issue.number}

### Title
${issue.title}

### Labels
${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}

### Body
${issue.body || "(empty)"}

### Allowed Paths
${allowedPaths.map(p => `- ${p}`).join("\n")}

## 出力形式

以下のJSON形式で出力してください。他のテキストは出力しないでください。

\`\`\`json
{
  "tasks": [
    {
      "title": "簡潔なタスク名",
      "goal": "機械判定可能な完了条件",
      "role": "worker or tester",
      "context": {
        "files": ["関連ファイルパス"],
        "specs": "詳細仕様",
        "notes": "補足情報"
      },
      "allowedPaths": ["変更許可パス"],
      "commands": ["検証コマンド（pnpm test / pnpm run dev など）"],
      "priority": 10,
      "riskLevel": "low",
      "dependsOn": [],
      "timeboxMinutes": 60
    }
  ],
  "warnings": []
}
\`\`\`

## 注意事項

- タスクは実行順序を考慮し、dependsOnで依存関係を明示
- dependsOn は必要最小限にし、並列で進められるタスクは依存を付けない
- 依存を過剰に張って直列化しない
 - 各タスクのcommandは成功/失敗を返すもの
 - dev起動の確認も含める
- フロントが絡むタスクはE2Eを必須とし、クリティカルパスを最低限カバーする
- riskLevelは "low" / "medium" / "high"
- timeboxMinutesは30〜90の範囲
- Issueのラベルからリスクレベルを推定
`.trim();
}

// ラベルからリスクレベルを推定
function inferRiskFromLabels(labels: string[]): "low" | "medium" | "high" {
  const lowercaseLabels = labels.map(l => l.toLowerCase());

  if (lowercaseLabels.some(l => 
    l.includes("critical") || 
    l.includes("security") || 
    l.includes("breaking")
  )) {
    return "high";
  }

  if (lowercaseLabels.some(l => 
    l.includes("bug") || 
    l.includes("fix") || 
    l.includes("important")
  )) {
    return "medium";
  }

  return "low";
}

// LLMレスポンスからJSONを抽出
function extractJsonFromResponse(response: string): unknown {
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const codeBlockContent = codeBlockMatch?.[1];
  if (codeBlockContent) {
    return JSON.parse(codeBlockContent.trim());
  }

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const jsonContent = jsonMatch?.[0];
  if (jsonContent) {
    return JSON.parse(jsonContent);
  }

  throw new Error("No valid JSON found in response");
}

// GitHub Issueからタスクを生成
export async function generateTasksFromIssue(
  issue: GitHubIssue,
  options: {
    workdir: string;
    allowedPaths: string[];
    instructionsPath?: string;
    timeoutSeconds?: number;
  }
): Promise<IssueAnalysisResult> {
  const prompt = buildPromptFromIssue(issue, options.allowedPaths);
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
  const defaultRisk = inferRiskFromLabels(issue.labels);
  const tasks: CreateTaskInput[] = parsed.tasks.map((task, index) => ({
    title: task.title,
    goal: task.goal,
    role: (task.role as "worker" | "tester" | undefined) ?? "worker",
    context: {
      ...task.context,
      notes: `GitHub Issue #${issue.number}: ${issue.title}\n${task.context?.notes ?? ""}`,
    },
    allowedPaths: task.allowedPaths,
    commands: task.commands,
    priority: task.priority ?? (parsed.tasks.length - index) * 10,
    riskLevel: (task.riskLevel as "low" | "medium" | "high") ?? defaultRisk,
    dependencies: [],
    timeboxMinutes: task.timeboxMinutes ?? 60,
    targetArea: undefined,
    touches: [],
  }));

  return {
    tasks,
    warnings: parsed.warnings ?? [],
    issueNumber: issue.number,
  };
}

// IssueからシンプルにタスクをLLMなしで生成（フォールバック用）
export function generateSimpleTaskFromIssue(
  issue: GitHubIssue,
  allowedPaths: string[]
): IssueAnalysisResult {
  const riskLevel = inferRiskFromLabels(issue.labels);

  const task: CreateTaskInput = {
    title: issue.title,
    goal: `Resolve GitHub Issue #${issue.number}`,
    role: "worker",
    context: {
      specs: issue.body,
      notes: `Labels: ${issue.labels.join(", ") || "none"}`,
    },
    allowedPaths,
    commands: ["pnpm test", "pnpm run check"],
    priority: 50,
    riskLevel,
    dependencies: [],
    timeboxMinutes: 60,
    targetArea: undefined,
    touches: [],
  };

  return {
    tasks: [task],
    warnings: ["Single task created from issue. Consider manual breakdown for complex issues."],
    issueNumber: issue.number,
  };
}
