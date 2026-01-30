import { runOpenCode } from "@h1ve/llm";
import { getOctokit, getRepoInfo } from "@h1ve/vcs";

// LLM評価結果
export interface LLMEvaluationResult {
  pass: boolean;
  confidence: number; // 0-1
  reasons: string[];
  suggestions: string[];
  codeIssues: CodeIssue[];
}

// コードの問題点
export interface CodeIssue {
  severity: "error" | "warning" | "info";
  category: "bug" | "security" | "performance" | "style" | "maintainability";
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

// PRのdiffを取得
async function getPRDiff(prNumber: number): Promise<string> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: {
      format: "diff",
    },
  });

  return response.data as unknown as string;
}

// レビュープロンプトを構築
function buildReviewPrompt(diff: string, taskGoal: string): string {
  return `
あなたはシニアソフトウェアエンジニアです。
以下のPRのdiffをレビューし、問題点を指摘してください。

## タスクの目標
${taskGoal}

## Diff
\`\`\`diff
${diff.slice(0, 10000)}${diff.length > 10000 ? "\n... (truncated)" : ""}
\`\`\`

## レビュー観点

1. **バグ**: 明らかなバグや論理エラー
2. **セキュリティ**: セキュリティ上の問題
3. **パフォーマンス**: パフォーマンス上の問題
4. **保守性**: コードの読みやすさ、保守性

## 出力形式

以下のJSON形式で出力してください。他のテキストは出力しないでください。

\`\`\`json
{
  "pass": true,
  "confidence": 0.9,
  "issues": [
    {
      "severity": "warning",
      "category": "style",
      "message": "問題の説明",
      "file": "path/to/file.ts",
      "line": 42,
      "suggestion": "改善案"
    }
  ],
  "summary": "全体的な評価コメント"
}
\`\`\`

## 判定基準

- **pass: true**: 重大な問題がない場合
- **pass: false**: バグやセキュリティ問題がある場合
- **confidence**: 判定の確信度（0-1）
`.trim();
}

// LLMレスポンスからJSONを抽出
function extractJsonFromResponse(response: string): unknown {
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const content = codeBlockMatch?.[1];
  if (content) {
    return JSON.parse(content.trim());
  }

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const jsonContent = jsonMatch?.[0];
  if (jsonContent) {
    return JSON.parse(jsonContent);
  }

  throw new Error("No valid JSON found in response");
}

// LLMでPRをレビュー
export async function evaluateLLM(
  prNumber: number,
  options: {
    taskGoal: string;
    workdir: string;
    instructionsPath?: string;
    timeoutSeconds?: number;
  }
): Promise<LLMEvaluationResult> {
  try {
    // PRのdiffを取得
    const diff = await getPRDiff(prNumber);

    if (!diff || diff.trim().length === 0) {
      return {
        pass: true,
        confidence: 0.5,
        reasons: ["No changes to review"],
        suggestions: [],
        codeIssues: [],
      };
    }

    // レビュープロンプトを構築
    const prompt = buildReviewPrompt(diff, options.taskGoal);
    const judgeModel = process.env.JUDGE_MODEL ?? "google/gemini-3-pro-preview";

    // OpenCodeを実行
    const result = await runOpenCode({
      workdir: options.workdir,
      instructionsPath: options.instructionsPath,
      task: prompt,
      model: judgeModel, // Judgeは高精度モデルでレビュー品質を優先する
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });

    if (!result.success) {
      console.warn("LLM review failed:", result.stderr);
      // LLM失敗時はデフォルトでパス（人間レビューを推奨）
      return {
        pass: true,
        confidence: 0,
        reasons: ["LLM review failed, manual review recommended"],
        suggestions: ["Request human review"],
        codeIssues: [],
      };
    }

    // レスポンスをパース
    const parsed = extractJsonFromResponse(result.stdout) as {
      pass: boolean;
      confidence: number;
      issues?: Array<{
        severity: string;
        category: string;
        message: string;
        file?: string;
        line?: number;
        suggestion?: string;
      }>;
      summary?: string;
    };

    // 問題点を変換
    const codeIssues: CodeIssue[] = (parsed.issues ?? []).map((issue) => ({
      severity: (issue.severity as "error" | "warning" | "info") ?? "warning",
      category: (issue.category as CodeIssue["category"]) ?? "maintainability",
      message: issue.message,
      file: issue.file,
      line: issue.line,
      suggestion: issue.suggestion,
    }));

    // 理由と提案を生成
    const reasons: string[] = [];
    const suggestions: string[] = [];

    if (!parsed.pass) {
      reasons.push(parsed.summary ?? "Code review found issues");
    }

    // 重要な問題を理由に追加
    const criticalIssues = codeIssues.filter((i) => i.severity === "error");
    for (const issue of criticalIssues) {
      reasons.push(`${issue.category}: ${issue.message}`);
      if (issue.suggestion) {
        suggestions.push(issue.suggestion);
      }
    }

    return {
      pass: parsed.pass,
      confidence: parsed.confidence,
      reasons,
      suggestions,
      codeIssues,
    };
  } catch (error) {
    console.error("LLM evaluation error:", error);
    return {
      pass: true,
      confidence: 0,
      reasons: ["LLM evaluation encountered an error"],
      suggestions: ["Request human review"],
      codeIssues: [],
    };
  }
}

// LLMなしでシンプルに評価（フォールバック用）
export function evaluateSimple(): LLMEvaluationResult {
  return {
    pass: true,
    confidence: 0,
    reasons: ["LLM review skipped"],
    suggestions: ["Consider manual code review"],
    codeIssues: [],
  };
}
