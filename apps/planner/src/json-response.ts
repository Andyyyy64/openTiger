const ANSI_ESCAPE_SEQUENCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_SEQUENCE, "g");
const CONTROL_CHARS_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const CONTROL_CHARS_REGEX = new RegExp(`[${CONTROL_CHARS_CLASS}]+`, "g");

function stripControlChars(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "").replace(CONTROL_CHARS_REGEX, "");
}

function extractCodeBlockCandidates(text: string): string[] {
  const candidates: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) {
      candidates.push(value);
    }
  }
  return candidates;
}

function extractBalancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const value = text.slice(start, i + 1).trim();
        if (value) {
          candidates.push(value);
        }
        start = -1;
      }
    }
  }

  return candidates;
}

function collectJsonCandidates(text: string): string[] {
  const normalized = stripControlChars(text);
  const ordered = [
    ...extractCodeBlockCandidates(normalized),
    ...extractBalancedObjectCandidates(normalized),
    normalized.trim(),
  ];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const value = candidate.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function extractJsonObjectFromText<T>(
  text: string,
  guard: (value: unknown) => value is T,
): T {
  const candidates = collectJsonCandidates(text);
  const parseErrors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (guard(parsed)) {
        return parsed;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(message);
    }
  }

  const hint = parseErrors.length > 0 ? ` (parse errors: ${parseErrors[0]})` : "";
  throw new Error(`No valid JSON found in response${hint}`);
}
