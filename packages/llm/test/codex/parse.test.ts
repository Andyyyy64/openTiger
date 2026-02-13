import { describe, expect, it } from "vitest";
import { extractCodexAssistantTextFromEventLine, parseCodexExecJson } from "../../src/codex/parse";

describe("extractCodexAssistantTextFromEventLine", () => {
  it("extracts assistant text from completed agent message", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}';
    expect(extractCodexAssistantTextFromEventLine(line)).toBe("OK");
  });

  it("returns undefined for non-assistant events", () => {
    const line = '{"type":"turn.started"}';
    expect(extractCodexAssistantTextFromEventLine(line)).toBeUndefined();
  });
});

describe("parseCodexExecJson", () => {
  it("parses assistant text and usage", () => {
    const output = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"First"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Second"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}',
    ].join("\n");

    const parsed = parseCodexExecJson(output);
    expect(parsed.assistantText).toBe("First\n\nSecond");
    expect(parsed.isError).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 160,
      cacheReadTokens: 40,
      cacheWriteTokens: undefined,
    });
  });

  it("captures error events", () => {
    const output = [
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 1/5"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}',
    ].join("\n");

    const parsed = parseCodexExecJson(output);
    expect(parsed.isError).toBe(true);
    expect(parsed.errors).toEqual(["Reconnecting... 1/5", "unexpected status 401 Unauthorized"]);
  });
});
