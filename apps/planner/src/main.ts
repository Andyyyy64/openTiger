import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { db, closeDb } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import { DEFAULT_CONFIG } from "./planner-config";
import { planFromRequirement } from "./planner-runner";
import { preparePlannerWorkdir } from "./planner-workdir";
import { startHeartbeat } from "./planner-heartbeat";

export { planFromContent } from "./planner-runner";

// ヘルプを表示
function showHelp(): void {
  console.log(`
openTiger Planner - Generate tasks from requirements

Usage:
  pnpm --filter @openTiger/planner start <requirement.md>
  pnpm --filter @openTiger/planner start --help

Options:
  --help          Show this help message
  --dry-run       Generate tasks but don't save to database
  --no-llm        差分点検が必須のため初期化以外では利用不可

Environment Variables:
  USE_LLM=false         Disable LLM generation
  DRY_RUN=true          Enable dry run mode
  PLANNER_TIMEOUT=300   LLM timeout in seconds
  PLANNER_MODEL=xxx     Planner LLM model
  PLANNER_INSPECT=false 差分点検は必須のため無視される
  PLANNER_INSPECT_TIMEOUT=180  LLM inspection timeout in seconds (<=0で無制限)
  PLANNER_INSPECT_MAX_RETRIES=-1  Inspection retry limit (-1で無制限)
  PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS=30000  Quota wait before retry

Example:
  pnpm --filter @openTiger/planner start docs/requirements/feature-x.md
`);
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

  // エージェント登録
  const agentId = process.env.AGENT_ID ?? "planner-1";
  setupProcessLogging(agentId, { label: "Planner" });
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";

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
        provider: "gemini",
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
    const requirementPath =
      args.find((arg) => !arg.startsWith("--")) ??
      process.env.REQUIREMENT_PATH ??
      process.env.REPLAN_REQUIREMENT_PATH;

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

    const { workdir, cleanup } = await preparePlannerWorkdir(config);
    try {
      await planFromRequirement(resolve(requirementPath), { ...config, workdir }, agentId);
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
