import { SHELL_CONTROL_PATTERN } from "./constants";

type ParsedCommand = {
  executable: string;
  args: string[];
  env: Record<string, string>;
};

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = index + 1 < command.length ? command[index + 1] : "";
    if (!char) {
      continue;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else if (quote === '"') {
        // ダブルクオート内では ", \, $, `, 改行 だけをエスケープとして扱う
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          escaped = true;
        } else {
          current += char;
        }
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (SHELL_CONTROL_PATTERN.test(trimmed)) {
    return null;
  }

  const tokens = tokenizeCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const env: Record<string, string> = {};
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      break;
    }
    const eqIndex = token.indexOf("=");
    env[token.slice(0, eqIndex)] = token.slice(eqIndex + 1);
    index += 1;
  }

  const executable = tokens[index];
  if (!executable) {
    return null;
  }

  return {
    executable,
    args: tokens.slice(index + 1),
    env,
  };
}
