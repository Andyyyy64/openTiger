export function matchDeniedCommand(command: string, deniedCommands: string[]): string | undefined {
  const target = command.trim();
  const lowerTarget = target.toLowerCase();

  for (const denied of deniedCommands) {
    const pattern = denied.trim();
    if (!pattern) {
      continue;
    }

    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(target)) {
        return denied;
      }
    } catch {
      // Treat as literal, not regex
    }

    if (lowerTarget.includes(pattern.toLowerCase())) {
      return denied;
    }
  }

  return undefined;
}

export function normalizeVerificationCommand(command: string): string {
  return command.trim();
}

function splitByAndAnd(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = i + 1 < command.length ? command[i + 1] : "";

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "&" && next === "&") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      i += 1;
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    parts.push(tail);
  }

  return parts;
}

export function expandVerificationCommand(command: string): string[] {
  const normalized = normalizeVerificationCommand(command);
  if (!normalized.includes("&&")) {
    return normalized.length > 0 ? [normalized] : [];
  }
  const expanded = splitByAndAnd(normalized).filter((entry) => entry.length > 0);
  return expanded.length > 0 ? expanded : [normalized];
}
