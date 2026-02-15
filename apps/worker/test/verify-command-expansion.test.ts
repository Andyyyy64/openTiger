import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expandVerificationCommandsWithCwd } from "../src/steps/verify/verify-changes";

describe("expandVerificationCommandsWithCwd", () => {
  it("applies chained cd to subsequent command cwd", () => {
    const repoPath = resolve("/tmp/opentiger-repo");
    const commands = expandVerificationCommandsWithCwd(
      [{ command: "cd packages/db && pnpm exec drizzle-kit generate", source: "explicit" }],
      repoPath,
    );

    expect(commands).toEqual([
      {
        command: "pnpm exec drizzle-kit generate",
        source: "explicit",
        cwd: resolve(repoPath, "packages/db"),
      },
    ]);
  });

  it("keeps cwd for non-cd chained commands", () => {
    const repoPath = resolve("/tmp/opentiger-repo");
    const commands = expandVerificationCommandsWithCwd(
      [{ command: "pnpm run build && pnpm run test", source: "auto" }],
      repoPath,
    );

    expect(commands).toEqual([
      { command: "pnpm run build", source: "auto", cwd: repoPath },
      { command: "pnpm run test", source: "auto", cwd: repoPath },
    ]);
  });

  it("does not rewrite cd commands that escape repository root", () => {
    const repoPath = resolve("/tmp/opentiger-repo");
    const commands = expandVerificationCommandsWithCwd(
      [{ command: "cd .. && pnpm run test", source: "explicit" }],
      repoPath,
    );

    expect(commands).toEqual([
      { command: "cd ..", source: "explicit", cwd: repoPath },
      { command: "pnpm run test", source: "explicit", cwd: repoPath },
    ]);
  });

  it("applies standalone cd command to later explicit commands", () => {
    const repoPath = resolve("/tmp/opentiger-repo");
    const commands = expandVerificationCommandsWithCwd(
      [
        { command: "cd packages/db", source: "explicit" },
        { command: "pnpm exec drizzle-kit generate", source: "explicit" },
      ],
      repoPath,
    );

    expect(commands).toEqual([
      {
        command: "pnpm exec drizzle-kit generate",
        source: "explicit",
        cwd: resolve(repoPath, "packages/db"),
      },
    ]);
  });

  it("does not leak explicit cwd into auto commands", () => {
    const repoPath = resolve("/tmp/opentiger-repo");
    const commands = expandVerificationCommandsWithCwd(
      [
        { command: "cd packages/db", source: "explicit" },
        { command: "pnpm run test", source: "auto" },
      ],
      repoPath,
    );

    expect(commands).toEqual([{ command: "pnpm run test", source: "auto", cwd: repoPath }]);
  });
});
