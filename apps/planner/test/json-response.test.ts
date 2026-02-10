import { describe, expect, it } from "vitest";
import { extractJsonObjectFromText } from "../src/json-response";

type TaskPayload = { tasks: Array<{ title: string }> };

function isTaskPayload(value: unknown): value is TaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { tasks?: unknown };
  return Array.isArray(record.tasks);
}

describe("extractJsonObjectFromText", () => {
  it("jsonコードブロックを抽出できる", () => {
    const input = `
analysis...
\`\`\`json
{"tasks":[{"title":"a"}]}
\`\`\`
`;
    const parsed = extractJsonObjectFromText(input, isTaskPayload);
    expect(parsed.tasks).toHaveLength(1);
  });

  it("先頭の無関係コードブロックをスキップして抽出できる", () => {
    const input = `
\`\`\`text
not json
\`\`\`
\`\`\`json
{"tasks":[{"title":"b"}]}
\`\`\`
`;
    const parsed = extractJsonObjectFromText(input, isTaskPayload);
    expect(parsed.tasks[0]?.title).toBe("b");
  });

  it("コードブロックが無くてもJSONオブジェクトを抽出できる", () => {
    const input = `prefix {"tasks":[{"title":"c"}]} suffix`;
    const parsed = extractJsonObjectFromText(input, isTaskPayload);
    expect(parsed.tasks[0]?.title).toBe("c");
  });
});
