import { spawn } from "node:child_process";
import { z } from "zod";

// 推論の深さを制御するeffortレベル（Opus 4.5向け）
export const EffortLevel = z.enum(["low", "medium", "high"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

// デフォルト設定（環境変数で上書き可能）
const DEFAULT_MODEL = process.env.CLAUDE_MODEL;
const DEFAULT_EFFORT: EffortLevel = (process.env.CLAUDE_EFFORT as EffortLevel) ?? "medium";

// Claude Code実行オプション
export const ClaudeCodeOptions = z.object({
  // 作業ディレクトリ
  workdir: z.string(),
  // 指示ファイルパス
  instructionsPath: z.string().optional(),
  // タスク内容
  task: z.string(),
  // タイムアウト（秒）
  timeoutSeconds: z.number().int().positive().default(3600),
  // 許可するツール
  allowedTools: z.array(z.string()).optional(),
  // 環境変数
  env: z.record(z.string()).optional(),
  // 使用モデル（省略時はClaude Codeのデフォルト = Opus 4.5）
  model: z.string().optional(),
  // 推論の深さ（low: 高速・低コスト、medium: バランス、high: 最高精度）
  effort: EffortLevel.optional(),
});
export type ClaudeCodeOptions = z.infer<typeof ClaudeCodeOptions>;

// 実行結果
export interface ClaudeCodeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// Claude Codeを実行
export async function runClaudeCode(
  options: ClaudeCodeOptions
): Promise<ClaudeCodeResult> {
  const startTime = Date.now();

  // コマンド引数を構築
  const args: string[] = [];

  // モデル指定（環境変数またはオプションで指定）
  const model = options.model ?? DEFAULT_MODEL;
  if (model) {
    args.push("--model", model);
  }

  // effort パラメータ（Opus 4.5向け推論深さ制御）
  const effort = options.effort ?? DEFAULT_EFFORT;
  args.push("--effort", effort);

  if (options.instructionsPath) {
    args.push("--instructions", options.instructionsPath);
  }

  // タスクをpromptとして渡す
  args.push("--prompt", options.task);

  // Claude Codeプロセスを起動
  const childProcess = spawn("claude", args, {
    cwd: options.workdir,
    env: {
      ...globalThis.process.env,
      ...options.env,
    },
    timeout: options.timeoutSeconds * 1000,
  });

  // 出力を収集
  let stdout = "";
  let stderr = "";

  childProcess.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  childProcess.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // 完了を待機
  return new Promise((resolve) => {
    childProcess.on("close", (code) => {
      const durationMs = Date.now() - startTime;

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs,
      });
    });

    childProcess.on("error", (error) => {
      const durationMs = Date.now() - startTime;

      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + error.message,
        durationMs,
      });
    });
  });
}
