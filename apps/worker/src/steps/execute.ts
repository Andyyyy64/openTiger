import type { Task, Policy } from "@sebastian-code/core";
import { runOpenCode, type OpenCodeResult } from "@sebastian-code/llm";
import { buildOpenCodeEnv } from "../env.js";

export interface ExecuteOptions {
  repoPath: string;
  task: Task;
  instructionsPath?: string;
  model?: string;
  retryHints?: string[];
  policy?: Policy;
}

export interface ExecuteResult {
  success: boolean;
  openCodeResult: OpenCodeResult;
  error?: string;
}

// タスクからOpenCode用のプロンプトを生成
function buildTaskPrompt(task: Task, retryHints: string[] = []): string {
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

  if (retryHints.length > 0) {
    lines.push("## Previous Attempt Failures");
    lines.push("Avoid repeating the same mistakes from previous attempts:");
    for (const hint of retryHints.slice(0, 3)) {
      lines.push(`- ${hint}`);
    }
    lines.push("");
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
    "- Add tests if applicable",
    "- Do not run any git operations (no commit/push/checkout/branch/rebase)"
  );

  return lines.join("\n");
}

function matchDeniedCommand(command: string, deniedCommands: string[]): string | undefined {
  const target = command.trim();
  const lowerTarget = target.toLowerCase();

  for (const denied of deniedCommands) {
    const pattern = denied.trim();
    if (!pattern) {
      continue;
    }

    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(target)) {
        return denied;
      }
    } catch {
      // 正規表現でなければ部分一致で判定する
    }

    if (lowerTarget.includes(pattern.toLowerCase())) {
      return denied;
    }
  }

  return undefined;
}

// OpenCodeを実行してタスクを遂行
export async function executeTask(
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const {
    repoPath,
    task,
    instructionsPath,
    model,
    retryHints = [],
    policy,
  } = options;

  for (const command of task.commands) {
    const deniedMatch = matchDeniedCommand(command, policy?.deniedCommands ?? []);
    if (deniedMatch) {
      const stderr = `Denied command detected before OpenCode execution: ${command} (matched: ${deniedMatch})`;
      const openCodeResult: OpenCodeResult = {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr,
        durationMs: 0,
        retryCount: 0,
      };
      return {
        success: false,
        openCodeResult,
        error: stderr,
      };
    }
  }

  const prompt = buildTaskPrompt(task, retryHints);
  const workerModel =
    model ??
    process.env.WORKER_MODEL ??
    process.env.OPENCODE_MODEL ??
    "google/gemini-3-flash-preview";

  console.log("Executing OpenCode...");
  console.log("Task:", task.title);

  // OpenCodeを実行
  const taskEnv = await buildOpenCodeEnv(repoPath);
  const openCodeResult = await runOpenCode({
    workdir: repoPath,
    instructionsPath,
    task: prompt,
    model: workerModel, // Workerは速度重視のモデルで実装を進める
    timeoutSeconds: task.timeboxMinutes * 60,
    env: taskEnv,
    inheritEnv: false,
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
