import { describe, expect, it } from "vitest";
import { isNonFastForwardPush } from "../src/steps/commit";

describe("isNonFastForwardPush", () => {
  it("detects classic non-fast-forward rejection text", () => {
    expect(isNonFastForwardPush("! [rejected] main -> main (non-fast-forward)", "")).toBe(true);
  });

  it("detects fetch-first rejection text", () => {
    expect(
      isNonFastForwardPush(
        "Updates were rejected because the remote contains work that you do not have locally. fetch first.",
        "",
      ),
    ).toBe(true);
  });

  it("detects failed refs message in stdout", () => {
    expect(isNonFastForwardPush("", "failed to push some refs to 'origin'")).toBe(true);
  });

  it("returns false for unrelated push errors", () => {
    expect(isNonFastForwardPush("connection reset by peer", "")).toBe(false);
  });
});
