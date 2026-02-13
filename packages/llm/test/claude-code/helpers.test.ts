import { describe, expect, it } from "vitest";
import {
  isClaudeCodeProvider,
  isRetryableClaudeError,
  normalizeClaudeModel,
  parseCsvSetting,
} from "../../src/claude-code/claude-code-helpers";

describe("isClaudeCodeProvider", () => {
  it("supports executor aliases", () => {
    expect(isClaudeCodeProvider("claude_code")).toBe(true);
    expect(isClaudeCodeProvider("claudecode")).toBe(true);
    expect(isClaudeCodeProvider("claude-code")).toBe(true);
  });

  it("rejects non-claude executors", () => {
    expect(isClaudeCodeProvider("opencode")).toBe(false);
    expect(isClaudeCodeProvider("codex")).toBe(false);
    expect(isClaudeCodeProvider(undefined)).toBe(false);
  });
});

describe("normalizeClaudeModel", () => {
  it("strips anthropic prefix", () => {
    expect(normalizeClaudeModel("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("falls back for obvious non-claude model IDs", () => {
    expect(normalizeClaudeModel("google/gemini-2.5-pro")).toBeUndefined();
    expect(normalizeClaudeModel("openai/gpt-5-codex")).toBeUndefined();
  });

  it("keeps plain claude model names", () => {
    expect(normalizeClaudeModel("claude-opus-4-5")).toBe("claude-opus-4-5");
  });
});

describe("parseCsvSetting", () => {
  it("supports comma and space separated values", () => {
    expect(parseCsvSetting("Read,Edit Bash(git:*)")).toEqual(["Read", "Edit", "Bash(git:*)"]);
  });
});

describe("isRetryableClaudeError", () => {
  it("does not retry auth failures", () => {
    expect(
      isRetryableClaudeError(
        "authentication_failed: Your account does not have access to Claude Code. Please run /login.",
        1,
      ),
    ).toBe(false);
  });

  it("retries transient overload errors", () => {
    expect(isRetryableClaudeError("rate limit exceeded (429)", 1)).toBe(true);
  });
});
