import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { db, closeDb } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import { DEFAULT_CONFIG } from "./planner-config";
import { planFromRequirement, planFromResearchJob } from "./planner-runner";
import { preparePlannerWorkdir } from "./planner-workdir";
import { startHeartbeat } from "./planner-heartbeat";

export { planFromContent } from "./planner-runner";

function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

function resolvePlannerExecutor(): "opencode" | "claude_code" | "codex" {
  const roleOverride = process.env.PLANNER_LLM_EXECUTOR;
  const fallback = process.env.LLM_EXECUTOR;
  if (roleOverride && roleOverride.trim().toLowerCase() !== "inherit") {
    if (isClaudeExecutor(roleOverride)) {
      return "claude_code";
    }
    if (isCodexExecutor(roleOverride)) {
      return "codex";
    }
    if (roleOverride.trim().toLowerCase() === "opencode") {
      return "opencode";
    }
  }
  if (isClaudeExecutor(fallback)) {
    return "claude_code";
  }
  if (isCodexExecutor(fallback)) {
    return "codex";
  }
  return "claude_code";
}

// ヘルプを表示
function showHelp(): void {
  console.log(`
openTiger Planner - Generate tasks from requirements

Usage:
  pnpm --filter @openTiger/planner start <requirement.md>
  pnpm --filter @openTiger/planner start --research-job <job-id>
  pnpm --filter @openTiger/planner start --help

Options:
  --help          Show this help message
  --dry-run       Generate tasks but don't save to database
  --no-llm        差分点検が必須のため初期化以外では利用不可
  --research-job  Run planner in TigerResearch mode for the target research job

Environment Variables:
  USE_LLM=false         Disable LLM generation
  DRY_RUN=true          Enable dry run mode
  PLANNER_TIMEOUT=1200   LLM timeout in seconds
  PLANNER_MODEL=xxx     Planner LLM model
  PLANNER_INSPECT=false 差分点検は必須のため無視される
  PLANNER_INSPECT_TIMEOUT=1200  LLM inspection timeout in seconds (<=0で無制限)
  PLANNER_INSPECT_MAX_RETRIES=-1  Inspection retry limit (-1で無制限)
  PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS=30000  Quota wait before retry

Example:
  pnpm --filter @openTiger/planner start docs/requirements/feature-x.md
`);
}

function parseOptionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }
  return value;
}

function findRequirementPathArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value || value.startsWith("--")) {
      continue;
    }
    const prev = index > 0 ? args[index - 1] : undefined;
    if (prev === "--research-job") {
      continue;
    }
    return value;
  }
  return undefined;
}

// メイン処理
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ヘルプ
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // 設定を構築
  const config = { ...DEFAULT_CONFIG };

  if (args.includes("--dry-run")) {
    config.dryRun = true;
  }

  if (args.includes("--no-llm")) {
    config.useLlm = false;
  }

  const researchJobId = parseOptionValue(args, "--research-job");
  const requirementArgPath = findRequirementPathArg(args);

  // エージェント登録
  const agentId = process.env.AGENT_ID ?? "planner-1";
  setupProcessLogging(agentId, { label: "Planner" });
  const plannerExecutor = resolvePlannerExecutor();
  process.env.LLM_EXECUTOR = plannerExecutor;
  const plannerModel =
    plannerExecutor === "claude_code"
      ? (process.env.CLAUDE_CODE_MODEL ?? "claude-opus-4-6")
      : plannerExecutor === "codex"
        ? (process.env.CODEX_MODEL ?? "gpt-5.3-codex")
        : (process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview");

  await db
    .insert(agents)
    .values({
      id: agentId,
      role: "planner",
      // 再計画の重複起動を避けるため、起動直後からbusyとして扱う
      status: "busy",
      lastHeartbeat: new Date(),
      metadata: {
        model: plannerModel, // Plannerは高精度モデルで計画品質を優先する
        provider: plannerExecutor,
      },
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        status: "busy",
        lastHeartbeat: new Date(),
      },
    });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);

  // 引数がない場合は環境変数の要件パスを利用する
  try {
    const { workdir, cleanup } = await preparePlannerWorkdir(config);
    try {
      if (researchJobId) {
        await planFromResearchJob(researchJobId, { ...config, workdir }, agentId);
      } else {
        const requirementPath =
          requirementArgPath ?? process.env.REQUIREMENT_PATH ?? process.env.REPLAN_REQUIREMENT_PATH;

        if (!requirementPath) {
          console.error("Error: Requirement file path is required");
          showHelp();
          throw new Error("Requirement file path is required");
        }

        // ファイルの存在確認
        try {
          await stat(requirementPath);
        } catch {
          console.error(`Error: File not found: ${requirementPath}`);
          throw new Error(`File not found: ${requirementPath}`);
        }

        await planFromRequirement(resolve(requirementPath), { ...config, workdir }, agentId);
      }
    } finally {
      await cleanup();
    }
  } finally {
    await db
      .update(agents)
      .set({ status: "idle", lastHeartbeat: new Date() })
      .where(eq(agents.id, agentId));
    clearInterval(heartbeatTimer);
    // 単発実行の終了でDB接続を閉じる
    await closeDb();
  }
}

main().catch((error) => {
  console.error("[Planner] Run ended with error (process keeps recoverable):", error);
});
