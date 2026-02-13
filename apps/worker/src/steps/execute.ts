import type { Task, Policy } from "@openTiger/core";
import { runOpenCode, type OpenCodeResult } from "@openTiger/llm";
import { buildOpenCodeEnv } from "../env";
import type { VerificationCommandSource } from "./verify/types";
import { buildPromptRuntimeContext } from "../context/prompt-context";

export interface VerificationRecoveryContext {
  attempt: number;
  failedCommand: string;
  failedCommandSource?: VerificationCommandSource;
  failedCommandStderr?: string;
}

export interface ExecuteOptions {
  repoPath: string;
  task: Task;
  instructionsPath?: string;
  model?: string;
  retryHints?: string[];
  policy?: Policy;
  verificationRecovery?: VerificationRecoveryContext;
}

export interface ExecuteResult {
  success: boolean;
  openCodeResult: OpenCodeResult;
  error?: string;
}

type ExecutorKind = "opencode" | "claude_code" | "codex";

function isClaudeExecutorValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutorValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

function resolveExecutorKindFromEnv(env: Record<string, string>): ExecutorKind {
  if (isClaudeExecutorValue(env.LLM_EXECUTOR) || isClaudeExecutorValue(process.env.LLM_EXECUTOR)) {
    return "claude_code";
  }
  if (isCodexExecutorValue(env.LLM_EXECUTOR) || isCodexExecutorValue(process.env.LLM_EXECUTOR)) {
    return "codex";
  }
  return "opencode";
}

function getExecutorDisplayName(executor: ExecutorKind): string {
  if (executor === "claude_code") {
    return "Claude Code";
  }
  if (executor === "codex") {
    return "Codex";
  }
  return "OpenCode";
}

function getExecutorLogTag(executor: ExecutorKind): string {
  if (executor === "claude_code") {
    return "ClaudeCode";
  }
  if (executor === "codex") {
    return "Codex";
  }
  return "OpenCode";
}

function isConflictAutoFixTask(task: Task): boolean {
  return /^\[AutoFix-Conflict\]\s+PR\s+#\d+/i.test(task.title.trim());
}

// Generate prompt for OpenCode from task
function summarizeRecoveryError(stderr: string | undefined, maxChars = 400): string {
  const normalized = (stderr ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function buildTaskPrompt(
  task: Task,
  retryHints: string[] = [],
  verificationRecovery?: VerificationRecoveryContext,
  runtimeContext?: {
    hostContextSummary?: string;
    failureHintSummary?: string;
  },
): string {
  const lines: string[] = [`# Task: ${task.title}`, "", "## Goal", task.goal, ""];

  if (runtimeContext?.hostContextSummary) {
    lines.push("## Host Context", runtimeContext.hostContextSummary, "");
  }
  if (runtimeContext?.failureHintSummary) {
    lines.push("## Failure Hints", runtimeContext.failureHintSummary, "");
  }

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
    if (task.context.pr?.number) {
      lines.push("## PR Context");
      lines.push(`- PR: #${task.context.pr.number}`);
      if (task.context.pr.url) {
        lines.push(`- URL: ${task.context.pr.url}`);
      }
      if (task.context.pr.headRef) {
        lines.push(`- Head Ref: ${task.context.pr.headRef}`);
      }
      if (task.context.pr.baseRef) {
        lines.push(`- Base Ref: ${task.context.pr.baseRef}`);
      }
      lines.push("");
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

  if (verificationRecovery) {
    const sourceLabel = verificationRecovery.failedCommandSource
      ? ` (${verificationRecovery.failedCommandSource})`
      : "";
    lines.push("## Verification Recovery");
    lines.push(
      `The previous verification attempt failed at command${sourceLabel}: ${verificationRecovery.failedCommand}`,
    );
    lines.push("Fix only what is necessary to pass this verification failure.");
    lines.push(
      `Failure details: ${summarizeRecoveryError(verificationRecovery.failedCommandStderr)}`,
    );
    lines.push(
      "After edits, ensure this command passes locally before finishing your response if feasible.",
    );
    lines.push("");
  }

  const importantRules: string[] = [
    "- Only modify files within the allowed paths",
    "- Ensure all verification commands pass",
    "- Write clear, maintainable code",
    "- Add tests if applicable",
  ];

  if (isConflictAutoFixTask(task)) {
    importantRules.push(
      "- Conflict autofix task: git commands for conflict resolution are allowed (fetch/status/diff/merge/checkout --ours/--theirs/add/restore)",
      "- Do not run git commit/push/rebase/reset/cherry-pick/branch operations; orchestrator handles commit/push/PR updates",
    );
  } else {
    importantRules.push("- Do not run any git operations (no commit/push/checkout/branch/rebase)");
  }

  importantRules.push(
    "- Do not run long-running dev/watch/start servers (forbidden: dev, watch, start, next dev, vite, turbo dev)",
    "- Never access files/directories outside the current repository working directory",
    "- Never use absolute paths outside the repository (forbidden examples: /home/*, /tmp/* from other workspaces)",
    "- If expected files are missing, report the mismatch and stop instead of scanning parent/home directories",
    "- Execute actions directly; do not emit repetitive planning chatter",
    "- Never call todo/todoread/todowrite pseudo tools",
  );

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
    ...importantRules,
  );

  return lines.join("\n");
}

function isDoomLoopFailure(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return (
    message.includes("doom loop detected") ||
    message.includes("excessive planning chatter detected") ||
    message.includes("unsupported pseudo tool call detected: todo")
  );
}

async function runOpenCodeWithGuard(params: {
  repoPath: string;
  instructionsPath?: string;
  task: string;
  model: string;
  timeoutSeconds: number;
  env: Record<string, string>;
  executor: ExecutorKind;
}): Promise<OpenCodeResult> {
  const hardTimeoutMs = (params.timeoutSeconds + 30) * 1000;
  const executorLogTag = getExecutorLogTag(params.executor);
  let hardTimeoutHandle: NodeJS.Timeout | undefined;
  const hardTimeoutResult = new Promise<OpenCodeResult>((resolve) => {
    hardTimeoutHandle = setTimeout(() => {
      resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `[${executorLogTag}] Hard timeout guard exceeded (${hardTimeoutMs}ms)`,
        durationMs: hardTimeoutMs,
        retryCount: 0,
      });
    }, hardTimeoutMs);
  });

  return Promise.race([
    runOpenCode({
      workdir: params.repoPath,
      instructionsPath: params.instructionsPath,
      task: params.task,
      model: params.model,
      timeoutSeconds: params.timeoutSeconds,
      env: params.env,
      inheritEnv: false,
    }),
    hardTimeoutResult,
  ]).finally(() => {
    if (hardTimeoutHandle) {
      clearTimeout(hardTimeoutHandle);
    }
  });
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
      // If not a regex, use partial match for evaluation
    }

    if (lowerTarget.includes(pattern.toLowerCase())) {
      return denied;
    }
  }

  return undefined;
}

// Execute OpenCode to complete task
export async function executeTask(options: ExecuteOptions): Promise<ExecuteResult> {
  const {
    repoPath,
    task,
    instructionsPath,
    model,
    retryHints = [],
    policy,
    verificationRecovery,
  } = options;

  for (const command of task.commands) {
    const deniedMatch = matchDeniedCommand(command, policy?.deniedCommands ?? []);
    if (deniedMatch) {
      const stderr = `Denied command detected before task execution: ${command} (matched: ${deniedMatch})`;
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

  const runtimeContext = await buildPromptRuntimeContext({
    task,
    failedCommand: verificationRecovery?.failedCommand,
  });
  const prompt = buildTaskPrompt(task, retryHints, verificationRecovery, runtimeContext);
  const workerModel =
    model ??
    process.env.WORKER_MODEL ??
    process.env.OPENCODE_MODEL ??
    "google/gemini-3-flash-preview";

  // Infer selected LLM engine from env for consistent logging
  const taskEnv = await buildOpenCodeEnv(repoPath);
  const executor = resolveExecutorKindFromEnv(taskEnv);
  const executorDisplayName = getExecutorDisplayName(executor);
  const executorLogTag = getExecutorLogTag(executor);

  console.log(`Executing ${executorDisplayName}...`);
  console.log("Task:", task.title);

  const timeoutCapSeconds = Number.parseInt(
    process.env.OPENCODE_TASK_TIMEOUT_CAP_SECONDS ?? "1800",
    10,
  );
  const safeTimeoutCapSeconds =
    Number.isFinite(timeoutCapSeconds) && timeoutCapSeconds > 0 ? timeoutCapSeconds : 1800;
  const requestedTimeoutSeconds = Math.max(
    Math.min(task.timeboxMinutes * 60, safeTimeoutCapSeconds),
    60,
  );
  let openCodeResult = await runOpenCodeWithGuard({
    repoPath,
    instructionsPath,
    task: prompt,
    model: workerModel,
    timeoutSeconds: requestedTimeoutSeconds,
    env: taskEnv,
    executor,
  });

  const enableImmediateRecovery = process.env.WORKER_IMMEDIATE_DOOM_RECOVERY !== "false";
  if (
    !openCodeResult.success &&
    enableImmediateRecovery &&
    isDoomLoopFailure(openCodeResult.stderr)
  ) {
    console.warn(
      `[${executorLogTag}] Doom loop detected. Retrying once in immediate recovery mode...`,
    );
    const recoveryTimeoutRaw = Number.parseInt(
      process.env.OPENCODE_RECOVERY_TIMEOUT_SECONDS ?? "420",
      10,
    );
    const recoveryTimeoutSeconds =
      Number.isFinite(recoveryTimeoutRaw) && recoveryTimeoutRaw > 0
        ? Math.min(requestedTimeoutSeconds, recoveryTimeoutRaw)
        : Math.min(requestedTimeoutSeconds, 420);
    const recoveryModel =
      process.env.WORKER_RECOVERY_MODEL ?? process.env.WORKER_MODEL ?? workerModel;
    const recoveryPrompt = `${prompt}

## Recovery Mode
The previous attempt failed due to a doom loop.
Do not output plan chatter. Read only minimal required files and then make edits.
Never call todo/todoread/todowrite pseudo tools.`;
    const recovered = await runOpenCodeWithGuard({
      repoPath,
      instructionsPath,
      task: recoveryPrompt,
      model: recoveryModel,
      timeoutSeconds: recoveryTimeoutSeconds,
      env: taskEnv,
      executor,
    });
    if (recovered.success) {
      openCodeResult = recovered;
    } else {
      openCodeResult = {
        ...recovered,
        stderr: `${recovered.stderr}\n[${executorLogTag}] Immediate recovery retry also failed.`,
      };
    }
  }

  if (!openCodeResult.success) {
    console.error(`${executorDisplayName} execution failed`);
    console.error("Exit code:", openCodeResult.exitCode);
    console.error("Stderr:", openCodeResult.stderr);

    return {
      success: false,
      openCodeResult,
      error: `${executorDisplayName} failed with exit code ${openCodeResult.exitCode}: ${openCodeResult.stderr}`,
    };
  }

  console.log(`${executorDisplayName} execution completed`);
  console.log("Duration:", Math.round(openCodeResult.durationMs / 1000), "seconds");

  return {
    success: true,
    openCodeResult,
  };
}
