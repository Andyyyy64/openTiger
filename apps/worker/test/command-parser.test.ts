import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/steps/verify/command-parser";

describe("parseCommand", () => {
  it("preserves backslashes for bracket literals inside double quotes", () => {
    const parsed = parseCommand('grep -q "\\[boot\\] kernel entry" build/boot_smoke.log');

    expect(parsed).toEqual({
      executable: "grep",
      args: ["-q", "\\[boot\\] kernel entry", "build/boot_smoke.log"],
      env: {},
    });
  });

  it("keeps non-special backslashes inside double quotes", () => {
    const parsed = parseCommand('echo "a\\[b"');

    expect(parsed).toEqual({
      executable: "echo",
      args: ["a\\[b"],
      env: {},
    });
  });

  it("still unescapes shell-special characters inside double quotes", () => {
    const parsed = parseCommand('echo "a\\$b"');

    expect(parsed).toEqual({
      executable: "echo",
      args: ["a$b"],
      env: {},
    });
  });
});
