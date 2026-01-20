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

// トークン使用量情報
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// パース結果
export interface ParsedOutput {
  summary: string;
  fileChanges: FileChange[];
  commandsRun: string[];
  errors: string[];
  tokenUsage?: TokenUsage;
}

// トークン使用量を抽出
export function extractTokenUsage(output: string): TokenUsage | undefined {
  // Claude Code CLIの出力からトークン使用量を抽出
  // 形式例: "Tokens: 1,234 input, 5,678 output (total: 6,912)"
  // または JSON 形式: {"input_tokens": 1234, "output_tokens": 5678}

  // JSON形式を試す
  const jsonMatch = output.match(/"input_tokens"\s*:\s*(\d+).*?"output_tokens"\s*:\s*(\d+)/s);
  if (jsonMatch) {
    const input = parseInt(jsonMatch[1] ?? "0", 10);
    const outputTokens = parseInt(jsonMatch[2] ?? "0", 10);
    return {
      inputTokens: input,
      outputTokens: outputTokens,
      totalTokens: input + outputTokens,
    };
  }

  // テキスト形式を試す
  const textMatch = output.match(/Tokens?:\s*([\d,]+)\s*input,?\s*([\d,]+)\s*output/i);
  if (textMatch) {
    const input = parseInt((textMatch[1] ?? "0").replace(/,/g, ""), 10);
    const outputTokens = parseInt((textMatch[2] ?? "0").replace(/,/g, ""), 10);
    return {
      inputTokens: input,
      outputTokens: outputTokens,
      totalTokens: input + outputTokens,
    };
  }

  // 別の形式: "Total tokens used: 6912"
  const totalMatch = output.match(/Total\s+tokens?\s*(?:used)?:\s*([\d,]+)/i);
  if (totalMatch) {
    const total = parseInt((totalMatch[1] ?? "0").replace(/,/g, ""), 10);
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: total,
    };
  }

  return undefined;
}

// Claude Codeの出力をパース
export function parseClaudeCodeOutput(output: string): ParsedOutput {
  const tokenUsage = extractTokenUsage(output);

  // ファイル変更を抽出（Claude Code CLI の出力形式に依存）
  const fileChanges: FileChange[] = [];
  const fileChangePattern = /(?:Created|Modified|Deleted)\s+([^\n]+)/g;
  let match;
  while ((match = fileChangePattern.exec(output)) !== null) {
    const path = match[1]?.trim();
    if (path) {
      const action = match[0].startsWith("Created")
        ? "create"
        : match[0].startsWith("Deleted")
          ? "delete"
          : "modify";
      fileChanges.push({
        path,
        action,
        linesAdded: 0,
        linesRemoved: 0,
      });
    }
  }

  // 実行されたコマンドを抽出
  const commandsRun: string[] = [];
  const commandPattern = /\$\s+([^\n]+)/g;
  while ((match = commandPattern.exec(output)) !== null) {
    const cmd = match[1]?.trim();
    if (cmd) {
      commandsRun.push(cmd);
    }
  }

  // サマリーを抽出（最後の段落または "Summary:" 以降）
  let summary = "Changes applied";
  const summaryMatch = output.match(/Summary:?\s*\n?([^\n]+)/i);
  if (summaryMatch?.[1]) {
    summary = summaryMatch[1].trim();
  }

  return {
    summary,
    fileChanges,
    commandsRun,
    errors: [],
    tokenUsage,
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
