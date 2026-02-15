import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveInlineRecoveryCommandCandidates,
  shouldAttemptInlineCommandRecovery,
} from "../src/steps/verify/verify-changes";

const createdDirs: string[] = [];
const originalInlineRecoveryEnv = process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY;

async function createRepo(structure: {
  rootScripts?: Record<string, string>;
  packageScripts?: Record<string, string>;
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
});
