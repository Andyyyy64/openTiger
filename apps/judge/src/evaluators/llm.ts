import { runOpenCode } from "@openTiger/llm";
import { getOctokit, getRepoInfo } from "@openTiger/vcs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\.?\//, "");
}

function extractChangedFilesFromDiff(diff: string): Set<string> {
  const files = new Set<string>();
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) {
      continue;
    }
    const left = normalizePath(match[1] ?? "");
    const right = normalizePath(match[2] ?? "");
    if (left) {
      files.add(left);
    }
    if (right) {
      files.add(right);
    }
  }
  return files;
}

function filterIssuesByDiffScope(
  issues: CodeIssue[],
  changedFiles: Set<string>
): { kept: CodeIssue[]; dropped: CodeIssue[] } {
  if (changedFiles.size === 0) {
    return { kept: issues, dropped: [] };
  }

  const kept: CodeIssue[] = [];
  const dropped: CodeIssue[] = [];

  for (const issue of issues) {
    if (!issue.file) {
      kept.push(issue);
      continue;
    }
    const normalized = normalizePath(issue.file);
    if (!normalized) {
      kept.push(issue);
      continue;
    }
    if (changedFiles.has(normalized)) {
      kept.push({ ...issue, file: normalized });
      continue;
    }
    dropped.push({ ...issue, file: normalized });
  }

  return { kept, dropped };
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
このレビューは与えられたDiffだけを根拠に行い、ファイルの作成・編集・削除を絶対に行わないでください。
外部コマンド実行やツール呼び出しは不要です。JSONのみ返してください。

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

async function runIsolatedJudgeReview(params: {
  task: string;
  model: string;
  instructionsPath?: string;
  timeoutSeconds: number;
}): ReturnType<typeof runOpenCode> {
  const isolatedWorkdir = await mkdtemp(join(tmpdir(), "openTiger-judge-llm-"));
  try {
    return await runOpenCode({
      workdir: isolatedWorkdir,
      instructionsPath: params.instructionsPath,
      task: params.task,
      model: params.model,
      timeoutSeconds: params.timeoutSeconds,
    });
  } finally {
    await rm(isolatedWorkdir, { recursive: true, force: true }).catch(() => undefined);
  }
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

function summarizeLlmExecutionFailure(stderr: string): string {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("quota")
    || lower.includes("resource_exhausted")
    || lower.includes("rate limit")
    || lower.includes("429")
  ) {
    return "LLM execution failed: quota_or_rate_limit";
  }
  if (lower.includes("doom loop detected")) {
    return "LLM execution failed: doom_loop_detected";
  }
  if (lower.includes("idle timeout") || lower.includes("timeout")) {
    return "LLM execution failed: timeout";
  }
  return "LLM execution failed: runtime_error";
}

// LLMでPRをレビュー
export async function evaluateLLM(
  prNumber: number,
  options: {
    taskGoal: string;
    instructionsPath?: string;
    timeoutSeconds?: number;
  }
): Promise<LLMEvaluationResult> {
  try {
    // PRのdiffを取得
    const diff = await getPRDiff(prNumber);
    const changedFiles = extractChangedFilesFromDiff(diff);

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
    const result = await runIsolatedJudgeReview({
      task: prompt,
      model: judgeModel, // Judgeは高精度モデルでレビュー品質を優先する
      instructionsPath: options.instructionsPath,
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });

    if (!result.success) {
      console.warn("LLM review failed:", result.stderr);
      const failureReason = summarizeLlmExecutionFailure(result.stderr);
      return {
        pass: false,
        confidence: 0,
        reasons: [failureReason],
        suggestions: ["Retry judge review after cooldown"],
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
    const rawIssues: CodeIssue[] = (parsed.issues ?? []).map((issue) => ({
      severity: (issue.severity as "error" | "warning" | "info") ?? "warning",
      category: (issue.category as CodeIssue["category"]) ?? "maintainability",
      message: issue.message,
      file: issue.file,
      line: issue.line,
      suggestion: issue.suggestion,
    }));
    const { kept: codeIssues, dropped: outOfScopeIssues } = filterIssuesByDiffScope(
      rawIssues,
      changedFiles
    );

    // 理由と提案を生成
    const reasons: string[] = [];
    const suggestions: string[] = [];

    const hasErrorIssue = codeIssues.some((issue) => issue.severity === "error");
    const effectivePass = parsed.pass || !hasErrorIssue;

    if (!effectivePass) {
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

    if (outOfScopeIssues.length > 0) {
      suggestions.push(
        `Ignored ${outOfScopeIssues.length} LLM issue(s) outside PR diff scope.`
      );
    }

    return {
      pass: effectivePass,
      confidence: parsed.confidence,
      reasons,
      suggestions,
      codeIssues,
    };
  } catch (error) {
    console.error("LLM evaluation error:", error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      confidence: 0,
      reasons: [`LLM evaluation encountered an error: ${message}`],
      suggestions: ["Retry judge review after cooldown"],
      codeIssues: [],
    };
  }
}

export async function evaluateLLMDiff(
  diff: string,
  taskGoal: string,
  options: {
    instructionsPath?: string;
    timeoutSeconds?: number;
  }
): Promise<LLMEvaluationResult> {
  try {
    if (!diff || diff.trim().length === 0) {
      return {
        pass: true,
        confidence: 0.5,
        reasons: ["No changes to review"],
        suggestions: [],
        codeIssues: [],
      };
    }

    const prompt = buildReviewPrompt(diff, taskGoal);
    const judgeModel = process.env.JUDGE_MODEL ?? "google/gemini-3-pro-preview";

    const result = await runIsolatedJudgeReview({
      task: prompt,
      model: judgeModel,
      instructionsPath: options.instructionsPath,
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });

    if (!result.success) {
      console.warn("LLM review failed:", result.stderr);
      const failureReason = summarizeLlmExecutionFailure(result.stderr);
      return {
        pass: false,
        confidence: 0,
        reasons: [failureReason],
        suggestions: ["Retry judge review after cooldown"],
        codeIssues: [],
      };
    }

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

    const changedFiles = extractChangedFilesFromDiff(diff);
    const rawIssues: CodeIssue[] = (parsed.issues ?? []).map((issue) => ({
      severity: (issue.severity as "error" | "warning" | "info") ?? "warning",
      category: (issue.category as CodeIssue["category"]) ?? "maintainability",
      message: issue.message,
      file: issue.file,
      line: issue.line,
      suggestion: issue.suggestion,
    }));
    const { kept: codeIssues, dropped: outOfScopeIssues } = filterIssuesByDiffScope(
      rawIssues,
      changedFiles
    );

    const reasons: string[] = [];
    const suggestions: string[] = [];

    const hasErrorIssue = codeIssues.some((issue) => issue.severity === "error");
    const effectivePass = parsed.pass || !hasErrorIssue;

    if (!effectivePass) {
      reasons.push(parsed.summary ?? "Code review found issues");
    }

    const criticalIssues = codeIssues.filter((i) => i.severity === "error");
    for (const issue of criticalIssues) {
      reasons.push(`${issue.category}: ${issue.message}`);
      if (issue.suggestion) {
        suggestions.push(issue.suggestion);
      }
    }

    if (outOfScopeIssues.length > 0) {
      suggestions.push(
        `Ignored ${outOfScopeIssues.length} LLM issue(s) outside PR diff scope.`
      );
    }

    return {
      pass: effectivePass,
      confidence: parsed.confidence,
      reasons,
      suggestions,
      codeIssues,
    };
  } catch (error) {
    console.error("LLM evaluation error:", error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      confidence: 0,
      reasons: [`LLM evaluation encountered an error: ${message}`],
      suggestions: ["Retry judge review after cooldown"],
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
