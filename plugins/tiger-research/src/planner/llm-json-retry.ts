import { runOpenCode } from "@openTiger/llm";
import { extractJsonObjectFromText } from "./json-response";

const DEFAULT_PARSE_REGEN_RETRIES = 2;
const DEFAULT_RECONCILE_TIMEOUT_SECONDS = 180;
const MAX_OUTPUT_PREVIEW_CHARS = 4000;
const ANSI_ESCAPE_SEQUENCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_SEQUENCE, "g");

function parseRetryCount(): number {
  const parsed = Number.parseInt(
    process.env.PLANNER_TASK_PARSE_REGEN_RETRIES ?? String(DEFAULT_PARSE_REGEN_RETRIES),
    10,
  );
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PARSE_REGEN_RETRIES;
  }
  return Math.max(0, parsed);
}

function parseReconcileTimeout(baseTimeoutSeconds: number): number {
  const parsed = Number.parseInt(
    process.env.PLANNER_TASK_PARSE_RECONCILE_TIMEOUT_SECONDS ??
      String(DEFAULT_RECONCILE_TIMEOUT_SECONDS),
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(60, Math.min(baseTimeoutSeconds, DEFAULT_RECONCILE_TIMEOUT_SECONDS));
  }
  return parsed;
}

function clipOutput(text: string): string {
  const normalized = text.replace(ANSI_ESCAPE_REGEX, "").trim();
  return normalized.slice(0, MAX_OUTPUT_PREVIEW_CHARS);
}

function summarizeOutputDiff(previous: string, current: string): string {
  const previousLines = new Set(
    previous
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const currentLines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  let added = 0;
  let removed = 0;
  for (const line of currentLines) {
    if (!previousLines.has(line)) {
      added += 1;
    }
  }
  for (const line of previousLines) {
    if (!currentLines.has(line)) {
      removed += 1;
    }
  }
  return `added_lines=${added}, removed_lines=${removed}`;
}

function buildRegenerationPrompt(basePrompt: string, previousOutput: string): string {
  return `${basePrompt}

## Re-Generation Instruction
The previous response could not be parsed as valid JSON.
Re-generate the full result and output JSON only.
Do not add explanations, markdown fences, or extra prose.

Previous response (for correction):
\`\`\`
${clipOutput(previousOutput)}
\`\`\``;
}

function buildReconcilePrompt(basePrompt: string, outputs: string[]): string {
  const candidates = outputs
    .slice(0, 3)
    .map(
      (output, index) => `Candidate ${index + 1}:
\`\`\`
${clipOutput(output)}
\`\`\``,
    )
    .join("\n\n");

  return `${basePrompt}

## Reconciliation Instruction
Multiple prior generations failed JSON parsing.
Compare the candidates, reconcile differences, and output only one valid JSON object.
Do not output markdown fences or any non-JSON text.

${candidates}`;
}

export async function generateAndParseWithRetry<T>(options: {
  workdir: string;
  model: string;
  prompt: string;
  timeoutSeconds: number;
  env: Record<string, string>;
  guard: (value: unknown) => value is T;
  label: string;
}): Promise<T> {
  const retryCount = parseRetryCount();
  const maxAttempts = retryCount + 1;
  const outputs: string[] = [];
  const parseErrors: string[] = [];

  let currentPrompt = options.prompt;
  let previousOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runOpenCode({
      workdir: options.workdir,
      task: currentPrompt,
      model: options.model,
      timeoutSeconds: options.timeoutSeconds,
      env: options.env,
    });

    if (!result.success) {
      throw new Error(`OpenCode failed: ${result.stderr}`);
    }

    outputs.push(result.stdout);
    try {
      return extractJsonObjectFromText(result.stdout, options.guard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(message);
      if (attempt < maxAttempts) {
        if (previousOutput) {
          const diffSummary = summarizeOutputDiff(previousOutput, result.stdout);
          console.warn(
            `[Planner] ${options.label} parse retry ${attempt}/${retryCount} (${diffSummary})`,
          );
        } else {
          console.warn(`[Planner] ${options.label} parse retry ${attempt}/${retryCount}`);
        }
        previousOutput = result.stdout;
        currentPrompt = buildRegenerationPrompt(options.prompt, result.stdout);
        continue;
      }
    }
  }

  if (outputs.length >= 2) {
    console.warn(
      `[Planner] ${options.label} parse retries exhausted. Trying reconciliation pass...`,
    );
    const reconcile = await runOpenCode({
      workdir: options.workdir,
      task: buildReconcilePrompt(options.prompt, outputs),
      model: options.model,
      timeoutSeconds: parseReconcileTimeout(options.timeoutSeconds),
      env: options.env,
    });

    if (reconcile.success) {
      try {
        return extractJsonObjectFromText(reconcile.stdout, options.guard);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parseErrors.push(`reconcile:${message}`);
      }
    } else {
      parseErrors.push(`reconcile OpenCode failed: ${reconcile.stderr}`);
    }
  }

  throw new Error(
    `Failed to parse LLM response after retries (${options.label}): ${parseErrors[0] ?? "unknown"}`,
  );
}
