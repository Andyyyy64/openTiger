import { describe, expect, it } from "vitest";
import {
  isCodexAuthFailure,
  isIgnorableCodexStderrLine,
  isCodexProvider,
  isRetryableCodexError,
  normalizeCodexModel,
} from "../../src/codex/codex-helpers";

describe("isCodexProvider", () => {
  it("supports codex executor aliases", () => {
    expect(isCodexProvider("codex")).toBe(true);
    expect(isCodexProvider("codex-cli")).toBe(true);
    expect(isCodexProvider("codex_cli")).toBe(true);
  });

  it("rejects non-codex values", () => {
    expect(isCodexProvider("opencode")).toBe(false);
    expect(isCodexProvider("claude_code")).toBe(false);
    expect(isCodexProvider(undefined)).toBe(false);
  });
});

describe("normalizeCodexModel", () => {
  it("strips openai prefix", () => {
    expect(normalizeCodexModel("openai/gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps codex slug without prefix", () => {
    expect(normalizeCodexModel("gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
  });

  it("returns undefined for empty values", () => {
    expect(normalizeCodexModel(" ")).toBeUndefined();
    expect(normalizeCodexModel(undefined)).toBeUndefined();
  });

  it("falls back for obvious non-codex model IDs", () => {
    expect(normalizeCodexModel("google/gemini-3-flash-preview")).toBeUndefined();
  });
});

describe("isCodexAuthFailure", () => {
  it("detects not logged in output", () => {
    expect(isCodexAuthFailure("Not logged in")).toBe(true);
  });

  it("detects unauthorized API key output", () => {
    expect(isCodexAuthFailure("401 Unauthorized: Incorrect API key provided")).toBe(true);
  });
});

describe("isIgnorableCodexStderrLine", () => {
  it("matches rollout path noise logs", () => {
    expect(
      isIgnorableCodexStderrLine(
        "2026-02-13T13:46:19.468181Z ERROR codex_core::rollout::list: state db missing rollout path for thread abc",
      ),
    ).toBe(true);
  });

  it("does not match normal stderr lines", () => {
    expect(isIgnorableCodexStderrLine("rate limit exceeded")).toBe(false);
  });
});

describe("isRetryableCodexError", () => {
  it("does not retry auth failures", () => {
    expect(isRetryableCodexError("Not logged in", 1)).toBe(false);
  });

  it("retries transient overload errors", () => {
    expect(isRetryableCodexError("rate limit exceeded (429)", 1)).toBe(true);
  });

  it("does not retry unsupported model errors", () => {
    expect(isRetryableCodexError("model is not supported", 1)).toBe(false);
  });
});
