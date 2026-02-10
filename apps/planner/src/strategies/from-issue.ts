import type { CreateTaskInput } from "@openTiger/core";
import { getPlannerOpenCodeEnv } from "../opencode-config";
import { generateAndParseWithRetry } from "../llm-json-retry";

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

export type IssueTaskRole = "worker" | "tester" | "docser";

// IssueからLLMプロンプトを構築
function buildPromptFromIssue(
  issue: GitHubIssue,
  allowedPaths: string[],
  explicitRole: IssueTaskRole,
): string {
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
7. **役割固定**: このIssueの担当ロールは固定で ${explicitRole}。全タスクの role は必ず ${explicitRole}

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
${allowedPaths.map((p) => `- ${p}`).join("\n")}

## 出力形式

以下のJSON形式で出力してください。他のテキストは出力しないでください。

\`\`\`json
{
  "tasks": [
    {
      "title": "簡潔なタスク名",
      "goal": "機械判定可能な完了条件",
      "role": "${explicitRole}",
      "context": {
        "files": ["関連ファイルパス"],
        "specs": "詳細仕様",
        "notes": "補足情報"
      },
      "allowedPaths": ["変更許可パス"],
      "commands": ["リポジトリのscriptsに合わせた検証コマンド（lint/test/typecheckなど）"],
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
- devなど常駐コマンドは検証に入れない
- フロントが絡むタスクはE2Eを必須とし、クリティカルパスを最低限カバーする
- role は必ず ${explicitRole} を使用する（他ロールは不可）
- riskLevelは "low" / "medium" / "high"
- timeboxMinutesは30〜90の範囲
- Issueのラベルからリスクレベルを推定
`.trim();
}

function normalizeRoleToken(value: string | null | undefined): IssueTaskRole | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "worker" || normalized === "tester" || normalized === "docser") {
    return normalized;
  }
  return null;
}

function parseRoleFromLabels(labels: string[]): IssueTaskRole | null {
  for (const raw of labels) {
    const label = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (label === "role:worker" || label === "agent:worker" || label === "worker") {
      return "worker";
    }
    if (label === "role:tester" || label === "agent:tester" || label === "tester") {
      return "tester";
    }
    if (label === "role:docser" || label === "agent:docser" || label === "docser") {
      return "docser";
    }
  }
  return null;
}

function parseRoleFromInlineBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }
  const inline = body.match(
    /^(?:\s*)(?:agent|role|担当(?:エージェント)?|実行エージェント)\s*[:：]\s*(worker|tester|docser)\s*$/im,
  );
  return normalizeRoleToken(inline?.[1] ?? null);
}

function parseRoleFromSectionBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }
  const lines = body.split(/\r?\n/);
  let inRoleSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^#{1,6}\s*(agent|role|担当(?:エージェント)?|実行エージェント)\b/i.test(line)) {
      inRoleSection = true;
      continue;
    }
    if (inRoleSection && /^#{1,6}\s+/.test(line)) {
      break;
    }
    if (!inRoleSection) {
      continue;
    }
    const bullet = line.match(/^[-*]\s*(.+)$/)?.[1] ?? line;
    const sectionRole = bullet.match(/\b(worker|tester|docser)\b/i)?.[1] ?? null;
    const normalized = normalizeRoleToken(sectionRole);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function parseExplicitRoleFromIssue(issue: GitHubIssue): IssueTaskRole | null {
  const fromLabel = parseRoleFromLabels(issue.labels);
  if (fromLabel) {
    return fromLabel;
  }
  const fromInline = parseRoleFromInlineBody(issue.body);
  if (fromInline) {
    return fromInline;
  }
  return parseRoleFromSectionBody(issue.body);
}

function buildMissingRoleWarning(issueNumber: number): string {
  return `Issue #${issueNumber}: explicit role is required. Add label role:worker|role:tester|role:docser or set "Agent: <role>" in body.`;
}

// ラベルからリスクレベルを推定
function inferRiskFromLabels(labels: string[]): "low" | "medium" | "high" {
  const lowercaseLabels = labels.map((l) => l.toLowerCase());

  if (
    lowercaseLabels.some(
      (l) => l.includes("critical") || l.includes("security") || l.includes("breaking"),
    )
  ) {
    return "high";
  }

  if (
    lowercaseLabels.some((l) => l.includes("bug") || l.includes("fix") || l.includes("important"))
  ) {
    return "medium";
  }

  return "low";
}

function isIssueTaskPayload(value: unknown): value is {
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
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { tasks?: unknown };
  return Array.isArray(record.tasks);
}

// GitHub Issueからタスクを生成
export async function generateTasksFromIssue(
  issue: GitHubIssue,
  options: {
    workdir: string;
    allowedPaths: string[];
    instructionsPath?: string;
    timeoutSeconds?: number;
  },
): Promise<IssueAnalysisResult> {
  const explicitRole = parseExplicitRoleFromIssue(issue);
  if (!explicitRole) {
    return {
      tasks: [],
      warnings: [buildMissingRoleWarning(issue.number)],
      issueNumber: issue.number,
    };
  }

  const prompt = buildPromptFromIssue(issue, options.allowedPaths, explicitRole);
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";

  // レスポンスをパース
  const parsed = await generateAndParseWithRetry<{
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
  }>({
    workdir: options.workdir,
    model: plannerModel, // Plannerは高精度モデルで計画品質を優先する
    prompt,
    timeoutSeconds: options.timeoutSeconds ?? 300,
    // Plannerはプロンプト内の情報だけで判断するためツールを使わない
    env: getPlannerOpenCodeEnv(),
    guard: isIssueTaskPayload,
    label: "Issue task generation",
  });

  // タスクを変換
  const defaultRisk = inferRiskFromLabels(issue.labels);
  const roleOverrideWarnings: string[] = [];
  const tasks: CreateTaskInput[] = parsed.tasks.map((task, index) => {
    const requestedRole = normalizeRoleToken(task.role ?? null);
    if (requestedRole && requestedRole !== explicitRole) {
      roleOverrideWarnings.push(
        `Issue #${issue.number}: task "${task.title}" role "${requestedRole}" was overridden to "${explicitRole}".`,
      );
    }
    return {
      title: task.title,
      goal: task.goal,
      role: explicitRole,
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
    };
  });

  return {
    tasks,
    warnings: [...(parsed.warnings ?? []), ...roleOverrideWarnings],
    issueNumber: issue.number,
  };
}

// IssueからシンプルにタスクをLLMなしで生成（フォールバック用）
export function generateSimpleTaskFromIssue(
  issue: GitHubIssue,
  allowedPaths: string[],
): IssueAnalysisResult {
  const riskLevel = inferRiskFromLabels(issue.labels);
  const explicitRole = parseExplicitRoleFromIssue(issue);
  if (!explicitRole) {
    return {
      tasks: [],
      warnings: [buildMissingRoleWarning(issue.number)],
      issueNumber: issue.number,
    };
  }

  const task: CreateTaskInput = {
    title: issue.title,
    goal: `Resolve GitHub Issue #${issue.number}`,
    role: explicitRole,
    context: {
      specs: issue.body,
      notes: `Labels: ${issue.labels.join(", ") || "none"}`,
    },
    allowedPaths,
    // 検証コマンドは固定せず、簡易チェックに委ねる
    commands: [],
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
