import { beforeEach, describe, expect, it, vi } from "vitest";

const { runClaudeCodeMock, runCodexMock, executeOpenCodeOnceMock } = vi.hoisted(() => ({
  runClaudeCodeMock: vi.fn(),
  runCodexMock: vi.fn(),
  executeOpenCodeOnceMock: vi.fn(),
}));

vi.mock("../../src/claude-code/run", () => ({
  runClaudeCode: runClaudeCodeMock,
}));

vi.mock("../../src/codex/run", () => ({
  runCodex: runCodexMock,
}));

vi.mock("../../src/opencode/opencode-executor", () => ({
  executeOpenCodeOnce: executeOpenCodeOnceMock,
}));

import { runOpenCode } from "../../src/opencode/run";

const successResult = {
  success: true,
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  durationMs: 1,
};

describe("runOpenCode executor selection", () => {
  beforeEach(() => {
    runClaudeCodeMock.mockReset();
    runCodexMock.mockReset();
    executeOpenCodeOnceMock.mockReset();
    runClaudeCodeMock.mockResolvedValue({ ...successResult, retryCount: 0 });
    runCodexMock.mockResolvedValue({ ...successResult, retryCount: 0 });
    executeOpenCodeOnceMock.mockResolvedValue(successResult);
  });

  it("routes to codex when provider is codex", async () => {
    const result = await runOpenCode({
      workdir: ".",
      task: "test",
      provider: "codex",
      maxRetries: 0,
      timeoutSeconds: 60,
    });

    expect(runCodexMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeMock).not.toHaveBeenCalled();
    expect(executeOpenCodeOnceMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("routes to codex when LLM_EXECUTOR is codex", async () => {
    const result = await runOpenCode({
      workdir: ".",
      task: "test",
      env: { LLM_EXECUTOR: "codex" },
      maxRetries: 0,
      timeoutSeconds: 60,
    });

    expect(runCodexMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeMock).not.toHaveBeenCalled();
    expect(executeOpenCodeOnceMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("routes to claude when provider is claude_code", async () => {
    const result = await runOpenCode({
      workdir: ".",
      task: "test",
      provider: "claude_code",
      maxRetries: 0,
      timeoutSeconds: 60,
    });

    expect(runClaudeCodeMock).toHaveBeenCalledTimes(1);
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(executeOpenCodeOnceMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("routes to opencode by default", async () => {
    const result = await runOpenCode({
      workdir: ".",
      task: "test",
      maxRetries: 0,
      timeoutSeconds: 60,
    });

    expect(executeOpenCodeOnceMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeMock).not.toHaveBeenCalled();
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
