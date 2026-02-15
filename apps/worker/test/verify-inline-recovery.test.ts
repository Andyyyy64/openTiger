import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@openTiger/core";
import {
  verifyChanges,
  resolveInlineRecoveryCommandCandidates,
  shouldAttemptInlineCommandRecovery,
} from "../src/steps/verify/verify-changes";
import type { LlmInlineRecoveryHandler } from "../src/steps/verify/types";

const createdDirs: string[] = [];
const originalInlineRecoveryEnv = process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY;
const originalLlmInlineAttemptsEnv = process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS;
const originalAutoVerifyModeEnv = process.env.WORKER_AUTO_VERIFY_MODE;

async function createRepo(structure: {
  rootScripts?: Record<string, string>;
  packageScripts?: Record<string, string>;
  lockfiles?: string[];
}): Promise<{ repoPath: string; packageDir: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "opentiger-verify-inline-"));
  createdDirs.push(repoPath);
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify(
      {
        name: "repo",
        private: true,
        scripts: structure.rootScripts ?? {},
      },
      null,
      2,
    ),
    "utf-8",
  );
  const packageDir = join(repoPath, "apps", "web");
  await mkdir(packageDir, { recursive: true });
  for (const lockfile of structure.lockfiles ?? []) {
    await writeFile(join(repoPath, lockfile), "", "utf-8");
  }
  if (structure.packageScripts) {
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: "@example/web",
          private: true,
          scripts: structure.packageScripts,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  return { repoPath, packageDir };
}

afterEach(async () => {
  if (originalInlineRecoveryEnv === undefined) {
    delete process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY;
  } else {
    process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY = originalInlineRecoveryEnv;
  }
  if (originalLlmInlineAttemptsEnv === undefined) {
    delete process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS;
  } else {
    process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS = originalLlmInlineAttemptsEnv;
  }
  if (originalAutoVerifyModeEnv === undefined) {
    delete process.env.WORKER_AUTO_VERIFY_MODE;
  } else {
    process.env.WORKER_AUTO_VERIFY_MODE = originalAutoVerifyModeEnv;
  }
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("shouldAttemptInlineCommandRecovery", () => {
  it("returns true for last unsupported-format failure", () => {
    const shouldAttempt = shouldAttemptInlineCommandRecovery({
      source: "explicit",
      command: "vitest run | tee out.log",
      output: "Unsupported command format. Shell operators are not allowed.",
      hasRemainingCommands: false,
    });

    expect(shouldAttempt).toBe(true);
  });

  it("returns false when there are remaining commands", () => {
    const shouldAttempt = shouldAttemptInlineCommandRecovery({
      source: "explicit",
      command: "vitest run | tee out.log",
      output: "Unsupported command format. Shell operators are not allowed.",
      hasRemainingCommands: true,
    });

    expect(shouldAttempt).toBe(false);
  });

  it("returns true for bootstrap failure even when there are remaining commands", () => {
    const shouldAttempt = shouldAttemptInlineCommandRecovery({
      source: "auto",
      command: "pnpm run build",
      output: "sh: 1: turbo: not found",
      hasRemainingCommands: true,
    });

    expect(shouldAttempt).toBe(true);
  });

  it("returns false when inline recovery is disabled", () => {
    process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY = "false";
    const shouldAttempt = shouldAttemptInlineCommandRecovery({
      source: "auto",
      command: "source .env",
      output: "Unsupported shell builtin in verification command: source",
      hasRemainingCommands: false,
    });

    expect(shouldAttempt).toBe(false);
  });
});

describe("resolveInlineRecoveryCommandCandidates", () => {
  it("prefers package-local scripts aligned to command intent", async () => {
    const { repoPath, packageDir } = await createRepo({
      rootScripts: { check: "echo check" },
      packageScripts: {
        test: "vitest run",
        typecheck: "tsc --noEmit",
      },
    });

    const candidates = await resolveInlineRecoveryCommandCandidates({
      repoPath,
      failedCommand: "vitest run | tee out.log",
      output: "Unsupported command format. Shell operators are not allowed.",
      failedCommandCwd: packageDir,
      singleChangedPackageDir: packageDir,
    });

    expect(candidates[0]).toEqual({
      command: "pnpm run test",
      cwd: packageDir,
    });
  });

  it("falls back to root scripts when package scripts are unavailable", async () => {
    const { repoPath, packageDir } = await createRepo({
      rootScripts: { check: "pnpm -r test" },
    });

    const candidates = await resolveInlineRecoveryCommandCandidates({
      repoPath,
      failedCommand: "source .env",
      output: "Unsupported shell builtin in verification command: source",
      failedCommandCwd: packageDir,
      singleChangedPackageDir: packageDir,
    });

    expect(candidates).toContainEqual({
      command: "pnpm run check",
      cwd: repoPath,
    });
  });

  it("prepends install candidates for setup/bootstrap failures", async () => {
    const { repoPath } = await createRepo({
      rootScripts: { build: "turbo build", check: "turbo lint && turbo typecheck" },
      lockfiles: ["pnpm-lock.yaml"],
    });

    const candidates = await resolveInlineRecoveryCommandCandidates({
      repoPath,
      failedCommand: "pnpm run build",
      output: "sh: 1: turbo: not found",
      failedCommandCwd: repoPath,
      singleChangedPackageDir: null,
    });

    expect(candidates[0]).toEqual({
      command: "pnpm install --frozen-lockfile",
      cwd: repoPath,
    });
    expect(candidates).toContainEqual({
      command: "pnpm install",
      cwd: repoPath,
    });
  });
});

describe("verifyChanges - LLM inline recovery context propagation", () => {
  it("passes previous execute failure hint to the next llm inline attempt", async () => {
    process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY = "false";
    process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS = "2";
    process.env.WORKER_AUTO_VERIFY_MODE = "fallback";
    const { repoPath } = await createRepo({});
    const calls: Parameters<LlmInlineRecoveryHandler>[0][] = [];
    const llmInlineRecoveryHandler: LlmInlineRecoveryHandler = async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        return {
          success: false,
          executeStderr: "[Codex] Timeout exceeded",
          executeError: "Task execution timed out",
        };
      }
      return { success: false };
    };

    const result = await verifyChanges({
      repoPath,
      commands: ["node -e process.exit(1)"],
      allowedPaths: ["**/*"],
      policy: DEFAULT_POLICY,
      allowNoChanges: true,
      llmInlineRecoveryHandler,
    });

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.previousExecuteFailureHint).toBeUndefined();
    expect(calls[1]?.previousExecuteFailureHint).toContain(
      "Previous recovery execution itself failed",
    );
    expect(calls[1]?.previousExecuteFailureHint).toContain("Timeout exceeded");
  });
});
