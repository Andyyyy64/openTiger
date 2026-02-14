import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stageChanges } from "../src/git";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "opentiger-vcs-stage-"));
  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "openTiger Test"]);
  return repoPath;
}

async function writeRepoFile(
  repoPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(repoPath, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

describe("stageChanges", () => {
  it("stages existing files even when multiple missing pathspecs are included", async () => {
    const repoPath = await createRepo();
    try {
      await writeRepoFile(repoPath, "apps/api/src/routes/requests.ts", "export const v = 1;\n");
      await runGit(repoPath, ["add", "-A"]);
      await runGit(repoPath, ["commit", "-m", "init"]);

      await writeRepoFile(repoPath, "apps/api/src/routes/requests.ts", "export const v = 2;\n");
      await writeRepoFile(
        repoPath,
        "apps/api/src/routes/approvals.ts",
        "export const ok = true;\n",
      );

      const result = await stageChanges(repoPath, [
        "apps/api/src/routes/requests.ts",
        "apps/api/src/routes/approvals.ts",
        "apps/api/src/test/mocks/hono.ts",
        "apps/api/src/test/mocks/hono-cors.ts",
        "apps/api/vitest.e2e.config.ts",
      ]);

      expect(result.success).toBe(true);
      const staged = await runGit(repoPath, ["diff", "--cached", "--name-only"]);
      expect(staged.split("\n")).toEqual([
        "apps/api/src/routes/approvals.ts",
        "apps/api/src/routes/requests.ts",
      ]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("preserves tracked file deletions while skipping untracked missing paths", async () => {
    const repoPath = await createRepo();
    try {
      await writeRepoFile(repoPath, "apps/api/src/obsolete.ts", "export const obsolete = true;\n");
      await writeRepoFile(repoPath, "apps/api/src/routes/requests.ts", "export const v = 1;\n");
      await runGit(repoPath, ["add", "-A"]);
      await runGit(repoPath, ["commit", "-m", "init"]);

      await rm(join(repoPath, "apps/api/src/obsolete.ts"));
      await writeRepoFile(repoPath, "apps/api/src/routes/requests.ts", "export const v = 2;\n");

      const result = await stageChanges(repoPath, [
        "apps/api/src/obsolete.ts",
        "apps/api/src/routes/requests.ts",
        "apps/api/src/test/mocks/hono.ts",
      ]);

      expect(result.success).toBe(true);
      const staged = await runGit(repoPath, ["diff", "--cached", "--name-only"]);
      expect(staged.split("\n")).toEqual([
        "apps/api/src/obsolete.ts",
        "apps/api/src/routes/requests.ts",
      ]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("stages a single tracked deletion by retrying with add -A", async () => {
    const repoPath = await createRepo();
    try {
      await writeRepoFile(repoPath, "deleted.txt", "to be removed\n");
      await runGit(repoPath, ["add", "-A"]);
      await runGit(repoPath, ["commit", "-m", "init"]);

      await rm(join(repoPath, "deleted.txt"));

      const result = await stageChanges(repoPath, ["deleted.txt"]);

      expect(result.success).toBe(true);
      const staged = await runGit(repoPath, ["diff", "--cached", "--name-only"]);
      expect(staged).toBe("deleted.txt");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
