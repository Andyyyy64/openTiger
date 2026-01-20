import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";

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

  if (options.instructionsPath) {
    args.push("--instructions", options.instructionsPath);
  }

  // タスクをpromptとして渡す
  args.push("--prompt", options.task);

  // Claude Codeプロセスを起動
  const process = spawn("claude", args, {
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

  process.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  process.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // 完了を待機
  return new Promise((resolve) => {
    process.on("close", (code) => {
      const durationMs = Date.now() - startTime;

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs,
      });
    });

    process.on("error", (error) => {
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
