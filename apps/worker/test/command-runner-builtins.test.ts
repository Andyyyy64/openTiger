import { describe, expect, it } from "vitest";
import { runCommand } from "../src/steps/verify/command-runner";

describe("runCommand shell builtins", () => {
  it("fails fast with clear message for unsupported shell builtins", async () => {
    const result = await runCommand("source .env", process.cwd());

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("Unsupported shell builtin");
    expect(result.stderr).toContain("source");
  });
});
