import { describe, expect, it } from "vitest";
import { isTitleGenerationLine, isTitleOnlyQuotaError } from "../../src/opencode/opencode-helpers";

describe("isTitleGenerationLine", () => {
  it("agent=title の行を検出する", () => {
    const line =
      "ERROR service=llm providerID=google modelID=gemini-3-flash-preview small=true agent=title mode=primary error=...";
    expect(isTitleGenerationLine(line)).toBe(true);
  });

  it("title generator の埋め込みプロンプトを検出する", () => {
    const line =
      'ERROR service=llm modelID=gemini-2.5-pro error={"name":"AI_RetryError","errors":[{"message":"Resource has been exhausted","requestBodyValues":{"contents":[{"parts":[{"text":"The following is the text to summarize"}]}],"systemInstruction":{"parts":[{"text":"You are a title generator. Generate a brief title."}]}}}]}';
    expect(isTitleGenerationLine(line)).toBe(true);
  });

  it("通常の build エラーは検出しない", () => {
    const line =
      "ERROR service=llm providerID=google modelID=gemini-2.5-pro agent=build error=Resource has been exhausted";
    expect(isTitleGenerationLine(line)).toBe(false);
  });
});

describe("isTitleOnlyQuotaError", () => {
  it("title由来のみの quota 行なら true", () => {
    const stderr =
      'ERROR service=llm modelID=gemini-2.5-pro error={"message":"Resource has been exhausted","requestBodyValues":{"parts":[{"text":"The following is the text to summarize"}],"systemInstruction":{"parts":[{"text":"You are a title generator"}]}}}';
    expect(isTitleOnlyQuotaError(stderr)).toBe(true);
  });

  it("title と build が混在する quota 行なら false", () => {
    const stderr = [
      "ERROR service=llm modelID=gemini-3-flash-preview small=true agent=title error=Resource has been exhausted",
      "ERROR service=llm modelID=gemini-2.5-pro agent=build error=Resource has been exhausted",
    ].join("\n");
    expect(isTitleOnlyQuotaError(stderr)).toBe(false);
  });
});
