import { runOpenCode } from "@openTiger/llm";
import { getOctokit, getRepoInfo } from "@openTiger/vcs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// LLM evaluation result
export interface LLMEvaluationResult {
  pass: boolean;
  confidence: number; // 0-1
  reasons: string[];
  suggestions: string[];
  codeIssues: CodeIssue[];
}

// Code issue
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
  changedFiles: Set<string>,
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

// Get PR diff
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

// Build review prompt
function buildReviewPrompt(diff: string, taskGoal: string): string {
  return `
You are a senior software engineer.
Review the PR diff below and identify issues.
Base your review only on the provided diff, and do not create, edit, or delete files.
Do not run external commands or call tools. Return JSON only.

## Task Goal
${taskGoal}

## Diff
\`\`\`diff
${diff.slice(0, 10000)}${diff.length > 10000 ? "\n... (truncated)" : ""}
\`\`\`

## Review Dimensions

1. **Bugs**: clear defects or logic errors
2. **Security**: security risks
3. **Performance**: performance problems
4. **Maintainability**: readability and long-term maintainability

## Output Format

Return JSON in the following format. Do not include any extra text.

\`\`\`json
{
  "pass": true,
  "confidence": 0.9,
  "issues": [
    {
      "severity": "warning",
      "category": "style",
      "message": "Issue description",
      "file": "path/to/file.ts",
      "line": 42,
      "suggestion": "Suggested fix"
    }
  ],
  "summary": "Overall review summary"
}
\`\`\`

## Decision Rules

- **pass: true**: no critical issues found
- **pass: false**: bugs or security issues found
- **confidence**: confidence score between 0 and 1
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

// Extract JSON from LLM response
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
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("429")
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

// Review PR with LLM
export async function evaluateLLM(
  prNumber: number,
  options: {
    taskGoal: string;
    instructionsPath?: string;
    timeoutSeconds?: number;
  },
): Promise<LLMEvaluationResult> {
  try {
    // Get PR diff
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

    // Build review prompt
    const prompt = buildReviewPrompt(diff, options.taskGoal);
    const judgeModel = process.env.JUDGE_MODEL ?? "google/gemini-3-pro-preview";

    // Run OpenCode
    const result = await runIsolatedJudgeReview({
      task: prompt,
      model: judgeModel, // Judge prefers high-quality model for review
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

    // Parse response
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

    // Map issues
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
      changedFiles,
    );

    // Generate reasons and suggestions
    const reasons: string[] = [];
    const suggestions: string[] = [];

    const hasErrorIssue = codeIssues.some((issue) => issue.severity === "error");
    const effectivePass = parsed.pass || !hasErrorIssue;

    if (!effectivePass) {
      reasons.push(parsed.summary ?? "Code review found issues");
    }

    // Add significant issues to reasons
    const criticalIssues = codeIssues.filter((i) => i.severity === "error");
    for (const issue of criticalIssues) {
      reasons.push(`${issue.category}: ${issue.message}`);
      if (issue.suggestion) {
        suggestions.push(issue.suggestion);
      }
    }

    if (outOfScopeIssues.length > 0) {
      suggestions.push(`Ignored ${outOfScopeIssues.length} LLM issue(s) outside PR diff scope.`);
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
  },
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
      changedFiles,
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
      suggestions.push(`Ignored ${outOfScopeIssues.length} LLM issue(s) outside PR diff scope.`);
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

// Simple evaluation without LLM (fallback)
export function evaluateSimple(): LLMEvaluationResult {
  return {
    pass: true,
    confidence: 0,
    reasons: ["LLM review skipped"],
    suggestions: ["Consider manual code review"],
    codeIssues: [],
  };
}
