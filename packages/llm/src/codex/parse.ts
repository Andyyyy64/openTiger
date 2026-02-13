export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CodexJsonlParseResult {
  assistantText: string;
  isError: boolean;
  errors: string[];
  tokenUsage?: CodexTokenUsage;
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

function readTextChunks(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => readTextChunks(item));
  }
  const record = value as Record<string, unknown>;
  const chunks: string[] = [];
  if (typeof record.text === "string") {
    const trimmed = record.text.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  }
  if (typeof record.output_text === "string") {
    const trimmed = record.output_text.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  }
  if (typeof record.message === "string") {
    const trimmed = record.message.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  }
  if ("content" in record) {
    chunks.push(...readTextChunks(record.content));
  }
  if ("delta" in record) {
    chunks.push(...readTextChunks(record.delta));
  }
  return chunks;
}

function parseTokenUsageFromUnknown(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = toNumber(
    record.input_tokens ?? record.inputTokens ?? record.prompt_tokens ?? record.promptTokens,
  );
  const outputTokens = toNumber(
    record.output_tokens ??
      record.outputTokens ??
      record.completion_tokens ??
      record.completionTokens,
  );
  const totalTokens =
    toNumber(record.total_tokens ?? record.totalTokens) || inputTokens + outputTokens;
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
  };
}

export function parseCodexJsonl(output: string): CodexJsonlParseResult {
  const lines = output.split(/\r?\n/);
  const assistantChunks: string[] = [];
  const errors: string[] = [];
  let isError = false;
  let tokenUsage: CodexTokenUsage | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";

    const directError = event.error;
    if (typeof directError === "string" && directError.trim().length > 0) {
      errors.push(directError.trim());
      isError = true;
    } else if (directError && typeof directError === "object") {
      const message = (directError as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim().length > 0) {
        errors.push(message.trim());
        isError = true;
      }
    }

    if (type === "error" && typeof event.message === "string" && event.message.trim().length > 0) {
      errors.push(event.message.trim());
      isError = true;
    }
    if (type.endsWith(".failed")) {
      isError = true;
    }

    if (type.startsWith("item.")) {
      assistantChunks.push(...readTextChunks(event.item));
    }
    if (type === "turn.completed" || type === "turn.output") {
      assistantChunks.push(...readTextChunks(event.output ?? event.item));
    }

    tokenUsage =
      parseTokenUsageFromUnknown(event.usage) ??
      parseTokenUsageFromUnknown((event.response as Record<string, unknown> | undefined)?.usage) ??
      tokenUsage;
  }

  return {
    assistantText: assistantChunks.join("\n").trim(),
    isError,
    errors,
    tokenUsage,
  };
}
