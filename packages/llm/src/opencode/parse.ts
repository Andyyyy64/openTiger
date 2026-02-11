import { z } from "zod";

// Changed file information (consider moving to packages/core if shared with Claude Code; using alias for now to avoid duplication)
export const OpenCodeFileChange = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
});
export type OpenCodeFileChange = z.infer<typeof OpenCodeFileChange>;

// Token usage information
export interface OpenCodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Parse result
export interface OpenCodeParsedOutput {
  summary: string;
  fileChanges: OpenCodeFileChange[];
  commandsRun: string[];
  errors: string[];
  tokenUsage?: OpenCodeTokenUsage;
}

// Extract token usage
export function extractOpenCodeTokenUsage(output: string): OpenCodeTokenUsage | undefined {
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

  return undefined;
}

// Parse OpenCode output
export function parseOpenCodeOutput(output: string): OpenCodeParsedOutput {
  const tokenUsage = extractOpenCodeTokenUsage(output);

  const fileChanges: OpenCodeFileChange[] = [];
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

  const commandsRun: string[] = [];
  const commandPattern = /\$\s+([^\n]+)/g;
  while ((match = commandPattern.exec(output)) !== null) {
    const cmd = match[1]?.trim();
    if (cmd) {
      commandsRun.push(cmd);
    }
  }

  let summary = "Changes applied via OpenCode";
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
