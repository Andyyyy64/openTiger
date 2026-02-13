import type { OpenCodeTokenUsage } from "../opencode/parse";

type CodexJsonRecord = Record<string, unknown>;

type CodexJsonItem = {
  type?: string;
  text?: string;
};

export interface CodexExecParseResult {
  assistantText: string;
  errors: string[];
  isError: boolean;
  tokenUsage?: OpenCodeTokenUsage;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function parseUsage(usage: unknown): OpenCodeTokenUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as CodexJsonRecord;
  const inputTokens = toFiniteNumber(record.input_tokens ?? record.inputTokens);
  const outputTokens = toFiniteNumber(record.output_tokens ?? record.outputTokens);
  const cacheReadTokens = toFiniteNumber(record.cached_input_tokens ?? record.cachedInputTokens);
  const cacheWriteTokens = toFiniteNumber(
    record.cache_creation_input_tokens ?? record.cacheWriteTokens,
  );

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens <= 0) {
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

function parseLine(line: string): CodexJsonRecord | null {
  try {
    return JSON.parse(line) as CodexJsonRecord;
  } catch {
    return null;
  }
}

function extractAssistantText(record: CodexJsonRecord): string | undefined {
  const type = record.type;
  if (type !== "item.completed") {
    return undefined;
  }
  const item = record.item;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const itemRecord = item as CodexJsonItem;
  if (itemRecord.type !== "agent_message") {
    return undefined;
  }
  const text = itemRecord.text;
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractErrorMessage(record: CodexJsonRecord): string | undefined {
  const type = record.type;
  if (type === "error") {
    const message = record.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
    return "Codex error";
  }
  if (type === "turn.failed") {
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as CodexJsonRecord).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim();
      }
    }
    return "Codex turn failed";
  }
  return undefined;
}

export function parseCodexExecJson(stdout: string): CodexExecParseResult {
  const assistantChunks: string[] = [];
  const errors: string[] = [];
  let tokenUsage: OpenCodeTokenUsage | undefined;
  let turnFailed = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const record = parseLine(line);
    if (!record) {
      continue;
    }

    const assistantText = extractAssistantText(record);
    if (assistantText) {
      assistantChunks.push(assistantText);
    }

    const errorMessage = extractErrorMessage(record);
    if (errorMessage) {
      errors.push(errorMessage);
    }
    if (record.type === "turn.failed") {
      turnFailed = true;
    }

    if (record.type === "turn.completed") {
      const parsedUsage = parseUsage(record.usage);
      if (parsedUsage) {
        tokenUsage = parsedUsage;
      }
    }
  }

  const assistantText = assistantChunks.join("\n\n").trim();
  const uniqueErrors = Array.from(new Set(errors));
  return {
    assistantText,
    errors: uniqueErrors,
    isError: turnFailed,
    tokenUsage,
  };
}

export function extractCodexAssistantTextFromEventLine(line: string): string | undefined {
  const record = parseLine(line.trim());
  if (!record) {
    return undefined;
  }
  return extractAssistantText(record);
}
