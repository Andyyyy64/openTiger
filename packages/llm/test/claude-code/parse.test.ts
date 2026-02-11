import { describe, it, expect } from "vitest";
import {
  FileChange,
  extractTokenUsage,
  parseClaudeCodeOutput,
  parseClaudeCodeStreamJson,
  extractErrorReason,
} from "../../src/claude-code/parse";

describe("FileChange schema", () => {
  it("validates valid file change", () => {
    const change = {
      path: "src/index.ts",
      action: "modify" as const,
      linesAdded: 10,
      linesRemoved: 5,
    };

    const result = FileChange.safeParse(change);
    expect(result.success).toBe(true);
  });

  it("accepts all action types", () => {
    const actions = ["create", "modify", "delete"] as const;
    for (const action of actions) {
      const change = {
        path: "test.ts",
        action,
        linesAdded: 0,
        linesRemoved: 0,
      };
      expect(FileChange.safeParse(change).success).toBe(true);
    }
  });

  it("rejects negative line counts", () => {
    const change = {
      path: "test.ts",
      action: "modify" as const,
      linesAdded: -1,
      linesRemoved: 0,
    };
    expect(FileChange.safeParse(change).success).toBe(false);
  });
});

describe("extractTokenUsage", () => {
  it("extracts token info from JSON format", () => {
    const output = `
      Processing...
      {"input_tokens": 1234, "output_tokens": 5678}
      Done.
    `;

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(1234);
    expect(usage?.outputTokens).toBe(5678);
    expect(usage?.totalTokens).toBe(6912);
  });

  it("extracts token info from text format", () => {
    const output = `
      Task completed successfully.
      Tokens: 1,234 input, 5,678 output
    `;

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(1234);
    expect(usage?.outputTokens).toBe(5678);
  });

  it("handles comma-separated numbers correctly", () => {
    const output = "Tokens: 100,000 input, 50,000 output";

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(100000);
    expect(usage?.outputTokens).toBe(50000);
  });

  it("extracts Total tokens format", () => {
    const output = "Total tokens used: 10,000";

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.totalTokens).toBe(10000);
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
  });

  it("returns undefined when no token info", () => {
    const output = "Task completed without token info.";

    const usage = extractTokenUsage(output);
    expect(usage).toBeUndefined();
  });
});

describe("parseClaudeCodeOutput", () => {
  it("detects file creation", () => {
    const output = `
      Created src/new-file.ts
      Created tests/new-file.test.ts
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(2);
    expect(result.fileChanges[0]).toEqual({
      path: "src/new-file.ts",
      action: "create",
      linesAdded: 0,
      linesRemoved: 0,
    });
  });

  it("detects file modification", () => {
    const output = "Modified src/index.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]?.action).toBe("modify");
  });

  it("detects file deletion", () => {
    const output = "Deleted src/old-file.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]?.action).toBe("delete");
  });

  it("detects executed commands", () => {
    const output = `
      $ pnpm install
      $ pnpm test
      $ pnpm build
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.commandsRun).toHaveLength(3);
    expect(result.commandsRun).toContain("pnpm install");
    expect(result.commandsRun).toContain("pnpm test");
    expect(result.commandsRun).toContain("pnpm build");
  });

  it("extracts summary", () => {
    const output = `
      Made changes...
      Summary: Added authentication middleware
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.summary).toBe("Added authentication middleware");
  });

  it("uses default when no summary", () => {
    const output = "Created file.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.summary).toBe("Changes applied");
  });

  it("includes token usage", () => {
    const output = `
      Modified src/index.ts
      {"input_tokens": 1000, "output_tokens": 500}
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.totalTokens).toBe(1500);
  });

  it("returns errors as empty array", () => {
    const output = "Some output";

    const result = parseClaudeCodeOutput(output);
    expect(result.errors).toEqual([]);
  });

  it("handles mixed output correctly", () => {
    const output = `
      Starting task...
      $ pnpm install
      Created src/auth/login.ts
      Modified src/index.ts
      $ pnpm test
      Summary: Implemented login feature
      Tokens: 5,000 input, 3,000 output
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(2);
    expect(result.commandsRun).toHaveLength(2);
    expect(result.summary).toBe("Implemented login feature");
    expect(result.tokenUsage?.inputTokens).toBe(5000);
  });
});

describe("extractErrorReason", () => {
  it("recognizes ENOENT error", () => {
    const stderr = "Error: ENOENT: no such file or directory";
    expect(extractErrorReason(stderr)).toBe("File or directory not found");
  });

  it("recognizes EACCES error", () => {
    const stderr = "Error: EACCES: permission denied";
    expect(extractErrorReason(stderr)).toBe("Permission denied");
  });

  it("recognizes ETIMEDOUT error", () => {
    const stderr = "Error: ETIMEDOUT: connection timed out";
    expect(extractErrorReason(stderr)).toBe("Operation timed out");
  });

  it("recognizes rate limit error", () => {
    const stderr = "API rate limit exceeded, please try again later";
    expect(extractErrorReason(stderr)).toBe("API rate limit exceeded");
  });

  it("returns last line for unknown errors", () => {
    const stderr = `Some context
More info
Actual error message`;
    expect(extractErrorReason(stderr)).toBe("Actual error message");
  });

  it("returns empty string for empty stderr", () => {
    const result = extractErrorReason("");
    expect(result).toBe("");
  });

  it("returns empty for whitespace-only stderr", () => {
    const result = extractErrorReason("   \n  \n  ");
    expect(result).toBe("");
  });
});

describe("parseClaudeCodeStreamJson", () => {
  it("extracts assistant/result/usage from stream-json format", () => {
    const output = `
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"First line"},{"type":"text","text":"Second line"}]}}
{"type":"result","is_error":false,"result":"Completed","usage":{"input_tokens":120,"output_tokens":80,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}
`;

    const parsed = parseClaudeCodeStreamJson(output);
    expect(parsed.assistantText).toBe("First line\nSecond line");
    expect(parsed.resultText).toBe("Completed");
    expect(parsed.isError).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.permissionDenials).toEqual([]);
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 215,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
    expect(parsed.rawEvents).toHaveLength(3);
  });

  it("picks up errors while ignoring unparseable lines", () => {
    const output = `
not-json-line
{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Auth failed"}]}}
{"type":"result","is_error":true,"result":"Please run /login.","usage":{"input_tokens":0,"output_tokens":0}}
`;

    const parsed = parseClaudeCodeStreamJson(output);
    expect(parsed.assistantText).toBe("Auth failed");
    expect(parsed.resultText).toBe("Please run /login.");
    expect(parsed.isError).toBe(true);
    expect(parsed.errors).toEqual(["authentication_failed"]);
    expect(parsed.permissionDenials).toEqual([]);
    expect(parsed.rawEvents).toHaveLength(2);
  });

  it("returns empty when no events", () => {
    const parsed = parseClaudeCodeStreamJson("");
    expect(parsed.assistantText).toBe("");
    expect(parsed.resultText).toBe("");
    expect(parsed.isError).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.permissionDenials).toEqual([]);
    expect(parsed.tokenUsage).toBeUndefined();
    expect(parsed.rawEvents).toEqual([]);
  });

  it("extracts permission_denials", () => {
    const output = `
{"type":"result","is_error":false,"result":"approval required","permission_denials":[{"tool_name":"Bash"}]}
`;
    const parsed = parseClaudeCodeStreamJson(output);
    expect(parsed.permissionDenials).toEqual(["Bash"]);
  });
});
