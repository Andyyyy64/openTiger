import { z } from "zod";

// Claude Codeの出力パース用

// 変更されたファイル情報
export const FileChange = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
});
export type FileChange = z.infer<typeof FileChange>;

// パース結果
export interface ParsedOutput {
  summary: string;
  fileChanges: FileChange[];
  commandsRun: string[];
  errors: string[];
  tokensUsed?: number;
}

// Claude Codeの出力をパース
export function parseClaudeCodeOutput(output: string): ParsedOutput {
  // TODO: 実際のClaude Code出力形式に合わせてパース
  // 現時点ではダミー実装

  return {
    summary: "Changes applied successfully",
    fileChanges: [],
    commandsRun: [],
    errors: [],
  };
}

// エラー出力から失敗理由を抽出
export function extractErrorReason(stderr: string): string | null {
  // よくあるエラーパターンをチェック
  if (stderr.includes("ENOENT")) {
    return "File or directory not found";
  }
  if (stderr.includes("EACCES")) {
    return "Permission denied";
  }
  if (stderr.includes("ETIMEDOUT")) {
    return "Operation timed out";
  }
  if (stderr.includes("rate limit")) {
    return "API rate limit exceeded";
  }

  // 最後の行を返す
  const lines = stderr.trim().split("\n");
  return lines.at(-1) ?? null;
}
