import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@h1ve/core";
import { runClaudeCode, type ClaudeCodeResult } from "@h1ve/llm";

export interface ExecuteOptions {
  repoPath: string;
  task: Task;
  instructionsPath?: string;
}

export interface ExecuteResult {
  success: boolean;
  claudeResult: ClaudeCodeResult;
  error?: string;
}

// タスクからClaude Code用のプロンプトを生成
function buildTaskPrompt(task: Task): string {
  const lines: string[] = [
    `# Task: ${task.title}`,
    "",
    "## Goal",
    task.goal,
    "",
  ];

  if (task.context) {
    if (task.context.specs) {
      lines.push("## Specifications", task.context.specs, "");
    }
    if (task.context.files && task.context.files.length > 0) {
      lines.push("## Related Files", ...task.context.files.map((f) => `- ${f}`), "");
    }
    if (task.context.notes) {
      lines.push("## Notes", task.context.notes, "");
    }
  }

  lines.push(
    "## Allowed Paths",
    "You may only modify files in these paths:",
    ...task.allowedPaths.map((p) => `- ${p}`),
    "",
    "## Verification Commands",
    "After making changes, run these commands to verify:",
    ...task.commands.map((c) => `- ${c}`),
    "",
    "## Important",
    "- Only modify files within the allowed paths",
    "- Ensure all verification commands pass",
    "- Write clear, maintainable code",
    "- Add tests if applicable"
  );

  return lines.join("\n");
}

// Claude Codeを実行してタスクを遂行
export async function executeTask(
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const { repoPath, task, instructionsPath } = options;

  const prompt = buildTaskPrompt(task);

  console.log("Executing Claude Code...");
  console.log("Task:", task.title);

  // Claude Codeを実行
  const claudeResult = await runClaudeCode({
    workdir: repoPath,
    task: prompt,
    instructionsPath,
    timeoutSeconds: task.timeboxMinutes * 60,
  });

  if (!claudeResult.success) {
    console.error("Claude Code execution failed");
    console.error("Exit code:", claudeResult.exitCode);
    console.error("Stderr:", claudeResult.stderr);

    return {
      success: false,
      claudeResult,
      error: `Claude Code failed with exit code ${claudeResult.exitCode}: ${claudeResult.stderr}`,
    };
  }

  console.log("Claude Code execution completed");
  console.log("Duration:", Math.round(claudeResult.durationMs / 1000), "seconds");

  return {
    success: true,
    claudeResult,
  };
}
