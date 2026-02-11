import { z } from "zod";

// Parse Claude Code output

// Changed file information
export const FileChange = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
});
export type FileChange = z.infer<typeof FileChange>;

// Token usage information
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Parse result
export interface ParsedOutput {
  summary: string;
  fileChanges: FileChange[];
  commandsRun: string[];
  errors: string[];
  tokenUsage?: TokenUsage;
}

export type ClaudeCodeStreamEvent = Record<string, unknown> & {
  type?: string;
};

export interface ClaudeCodeStreamParseResult {
  assistantText: string;
  resultText: string;
  isError: boolean;
  errors: string[];
  permissionDenials: string[];
  tokenUsage?: TokenUsage;
  rawEvents: ClaudeCodeStreamEvent[];
}

// Extract token usage
export function extractTokenUsage(output: string): TokenUsage | undefined {
  // Extract token usage from Claude Code CLI output
  // Example format: "Tokens: 1,234 input, 5,678 output (total: 6,912)"
  // Or JSON format: {"input_tokens": 1234, "output_tokens": 5678}

  // Try JSON format
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

  // Try text format
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

  // Another format: "Total tokens used: 6912"
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

// Parse Claude Code output
export function parseClaudeCodeOutput(output: string): ParsedOutput {
  const tokenUsage = extractTokenUsage(output);

  // Extract file changes (depends on Claude Code CLI output format)
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

  // Extract executed commands
  const commandsRun: string[] = [];
  const commandPattern = /\$\s+([^\n]+)/g;
  while ((match = commandPattern.exec(output)) !== null) {
    const cmd = match[1]?.trim();
    if (cmd) {
      commandsRun.push(cmd);
    }
  }

  // Extract summary (last paragraph or after "Summary:")
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

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function parseStreamUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = toNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = toNumber(usage.output_tokens ?? usage.outputTokens);
  const cacheReadTokens = toNumber(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
  );
  const cacheWriteTokens = toNumber(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheWriteTokens,
  );
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
  };
}

function extractAssistantTexts(event: ClaudeCodeStreamEvent): string[] {
  const message = event.message;
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = record.text;
    if (typeof text === "string" && text.trim().length > 0) {
      chunks.push(text.trim());
    }
  }
  return chunks;
}

export function parseClaudeCodeStreamJson(output: string): ClaudeCodeStreamParseResult {
  const rawEvents: ClaudeCodeStreamEvent[] = [];
  const assistantChunks: string[] = [];
  const errors: string[] = [];
  const permissionDenials: string[] = [];
  let tokenUsage: TokenUsage | undefined;
  let resultText = "";
  let isError = false;

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: ClaudeCodeStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as ClaudeCodeStreamEvent;
    } catch {
      continue;
    }

    rawEvents.push(parsed);
    const eventType = parsed.type;
    if (eventType === "assistant") {
      assistantChunks.push(...extractAssistantTexts(parsed));
    }

    const eventError = parsed.error;
    if (typeof eventError === "string" && eventError.trim().length > 0) {
      errors.push(eventError.trim());
    }

    if (eventType === "result") {
      const resultValue = parsed.result;
      if (typeof resultValue === "string" && resultValue.trim().length > 0) {
        resultText = resultValue.trim();
      }
      const eventIsError = parsed.is_error;
      if (typeof eventIsError === "boolean") {
        isError = eventIsError;
      }
      const parsedUsage = parseStreamUsage(parsed.usage);
      if (parsedUsage) {
        tokenUsage = parsedUsage;
      }
      const denialList = parsed.permission_denials;
      if (Array.isArray(denialList)) {
        for (const denial of denialList) {
          if (!denial || typeof denial !== "object") {
            permissionDenials.push("permission_denied");
            continue;
          }
          const record = denial as Record<string, unknown>;
          const toolName = record.tool_name;
          if (typeof toolName === "string" && toolName.trim().length > 0) {
            permissionDenials.push(toolName.trim());
          } else {
            permissionDenials.push("permission_denied");
          }
        }
      }
    }
  }

  return {
    assistantText: assistantChunks.join("\n").trim(),
    resultText,
    isError,
    errors,
    permissionDenials,
    tokenUsage,
    rawEvents,
  };
}

// Extract failure reason from error output
export function extractErrorReason(stderr: string): string | null {
  // Check common error patterns
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

  // Return last line
  const lines = stderr.trim().split("\n");
  return lines.at(-1) ?? null;
}
