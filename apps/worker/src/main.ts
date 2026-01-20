import type { Task } from "@h1ve/core";

// Worker: タスクを実行してPRを作成する
// 1. リポジトリをcheckout
// 2. 作業ブランチ作成
// 3. Claude Code実行
// 4. 変更をverify（lint/test）
// 5. コミット & プッシュ
// 6. PR作成

interface WorkerConfig {
  agentId: string;
  repoPath: string;
  workspacePath: string;
}

interface ExecutionResult {
  success: boolean;
  prUrl?: string;
  errorMessage?: string;
  costTokens?: number;
}

async function executeTask(
  task: Task,
  config: WorkerConfig
): Promise<ExecutionResult> {
  const branchName = `agent/${config.agentId}/${task.id}`;

  console.log(`Executing task: ${task.title}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Allowed paths: ${task.allowedPaths.join(", ")}`);

  try {
    // Step 1: Checkout repository
    console.log("Step 1: Checking out repository...");
    // TODO: Implement git checkout

    // Step 2: Create branch
    console.log(`Step 2: Creating branch ${branchName}...`);
    // TODO: Implement branch creation

    // Step 3: Execute Claude Code
    console.log("Step 3: Executing Claude Code...");
    // TODO: Implement Claude Code execution

    // Step 4: Verify changes
    console.log("Step 4: Verifying changes...");
    for (const command of task.commands) {
      console.log(`  Running: ${command}`);
      // TODO: Execute verification commands
    }

    // Step 5: Commit and push
    console.log("Step 5: Committing and pushing...");
    // TODO: Implement git commit and push

    // Step 6: Create PR
    console.log("Step 6: Creating PR...");
    // TODO: Implement PR creation

    return {
      success: true,
      prUrl: `https://github.com/example/repo/pull/123`,
      costTokens: 1000,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Task execution failed: ${message}`);

    return {
      success: false,
      errorMessage: message,
    };
  }
}

// メイン処理（テスト用）
async function main() {
  console.log("Worker started");
  console.log("Waiting for tasks...");

  // TODO: キューからタスクを受け取って実行
  // 現時点ではデモ用のダミー処理
}

main().catch(console.error);
