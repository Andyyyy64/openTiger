import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "../../src/codex/parse";

describe("parseCodexJsonl", () => {
  it("extracts assistant text and usage", () => {
    const output = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"assistant_message","content":[{"type":"output_text","text":"Implemented fix"}]}}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150}}',
    ].join("\n");

    const parsed = parseCodexJsonl(output);
    expect(parsed.assistantText).toContain("Implemented fix");
    expect(parsed.isError).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it("collects error messages and marks failure", () => {
    const output = [
      '{"type":"error","message":"unexpected status 401 Unauthorized"}',
      '{"type":"turn.failed","error":{"message":"auth error"}}',
    ].join("\n");
    const parsed = parseCodexJsonl(output);
    expect(parsed.isError).toBe(true);
    expect(parsed.errors).toContain("unexpected status 401 Unauthorized");
    expect(parsed.errors).toContain("auth error");
  });
});
