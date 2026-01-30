import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@h1ve/core";
import { runOpenCode, type OpenCodeResult } from "@h1ve/llm";

export interface ExecuteOptions {
  repoPath: string;
  task: Task;
  instructionsPath?: string;
  model?: string;
}

export interface ExecuteResult {
  success: boolean;
  openCodeResult: OpenCodeResult;
  error?: string;
}

// タスクからOpenCode用のプロンプトを生成
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

// OpenCodeを実行してタスクを遂行
export async function executeTask(
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const { repoPath, task, instructionsPath, model } = options;

  const prompt = buildTaskPrompt(task);
  const workerModel =
    model ??
    process.env.WORKER_MODEL ??
    process.env.OPENCODE_MODEL ??
    "google/gemini-3-flash-preview";

  console.log("Executing OpenCode...");
  console.log("Task:", task.title);

  // OpenCodeを実行
  const openCodeResult = await runOpenCode({
    workdir: repoPath,
    instructionsPath,
    task: prompt,
    model: workerModel, // Workerは速度重視のモデルで実装を進める
    timeoutSeconds: task.timeboxMinutes * 60,
  });

  if (!openCodeResult.success) {
    console.error("OpenCode execution failed");
    console.error("Exit code:", openCodeResult.exitCode);
    console.error("Stderr:", openCodeResult.stderr);

    return {
      success: false,
      openCodeResult,
      error: `OpenCode failed with exit code ${openCodeResult.exitCode}: ${openCodeResult.stderr}`,
    };
  }

  console.log("OpenCode execution completed");
  console.log("Duration:", Math.round(openCodeResult.durationMs / 1000), "seconds");

  return {
    success: true,
    openCodeResult,
  };
}
