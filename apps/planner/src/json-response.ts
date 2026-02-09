function stripControlChars(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
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
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
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

