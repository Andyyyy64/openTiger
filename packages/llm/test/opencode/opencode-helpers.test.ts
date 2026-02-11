import { describe, expect, it } from "vitest";
import { isTitleGenerationLine, isTitleOnlyQuotaError } from "../../src/opencode/opencode-helpers";

describe("isTitleGenerationLine", () => {
  it("detects agent=title line", () => {
    const line =
      "ERROR service=llm providerID=google modelID=gemini-3-flash-preview small=true agent=title mode=primary error=...";
    expect(isTitleGenerationLine(line)).toBe(true);
  });

  it("detects title generator embedded prompt", () => {
    const line =
      'ERROR service=llm modelID=gemini-2.5-pro error={"name":"AI_RetryError","errors":[{"message":"Resource has been exhausted","requestBodyValues":{"contents":[{"parts":[{"text":"The following is the text to summarize"}]}],"systemInstruction":{"parts":[{"text":"You are a title generator. Generate a brief title."}]}}}]}';
    expect(isTitleGenerationLine(line)).toBe(true);
  });

  it("does not detect normal build error", () => {
    const line =
      "ERROR service=llm providerID=google modelID=gemini-2.5-pro agent=build error=Resource has been exhausted";
    expect(isTitleGenerationLine(line)).toBe(false);
  });
});

describe("isTitleOnlyQuotaError", () => {
  it("returns true when quota lines are title-derived only", () => {
    const stderr =
      'ERROR service=llm modelID=gemini-2.5-pro error={"message":"Resource has been exhausted","requestBodyValues":{"parts":[{"text":"The following is the text to summarize"}],"systemInstruction":{"parts":[{"text":"You are a title generator"}]}}}';
    expect(isTitleOnlyQuotaError(stderr)).toBe(true);
  });

  it("returns false when title and build quota lines mixed", () => {
    const stderr = [
      "ERROR service=llm modelID=gemini-3-flash-preview small=true agent=title error=Resource has been exhausted",
      "ERROR service=llm modelID=gemini-2.5-pro agent=build error=Resource has been exhausted",
    ].join("\n");
    expect(isTitleOnlyQuotaError(stderr)).toBe(false);
  });
});
