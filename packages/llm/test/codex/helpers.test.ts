import { describe, expect, it } from "vitest";
import {
  isCodexAuthFailure,
  isCodexProvider,
  isRetryableCodexError,
  normalizeCodexModel,
} from "../../src/codex/codex-helpers";

describe("isCodexProvider", () => {
  it("supports codex aliases", () => {
    expect(isCodexProvider("codex")).toBe(true);
    expect(isCodexProvider("openai_codex")).toBe(true);
    expect(isCodexProvider("openai-codex")).toBe(true);
  });

  it("rejects non-codex providers", () => {
    expect(isCodexProvider("opencode")).toBe(false);
    expect(isCodexProvider("claude_code")).toBe(false);
    expect(isCodexProvider(undefined)).toBe(false);
  });
});

describe("normalizeCodexModel", () => {
  it("strips openai prefix", () => {
    expect(normalizeCodexModel("openai/gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("keeps plain codex model names", () => {
    expect(normalizeCodexModel("codex-mini-latest")).toBe("codex-mini-latest");
  });

  it("falls back for clearly non-codex model IDs", () => {
    expect(normalizeCodexModel("google/gemini-2.5-pro")).toBeUndefined();
    expect(normalizeCodexModel("anthropic/claude-opus-4-6")).toBeUndefined();
  });
});

describe("isCodexAuthFailure", () => {
  it("detects 401 auth failures", () => {
    expect(
      isCodexAuthFailure(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toBe(true);
  });
});

describe("isRetryableCodexError", () => {
  it("does not retry auth failures", () => {
    expect(
      isRetryableCodexError(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        1,
      ),
    ).toBe(false);
  });

  it("retries transient overload errors", () => {
    expect(isRetryableCodexError("rate limit exceeded (429)", 1)).toBe(true);
  });
});
