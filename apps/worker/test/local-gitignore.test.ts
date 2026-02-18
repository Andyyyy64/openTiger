import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLocalGitIgnoreEntries,
  resolveGitInfoExcludePath,
  resolveLocalGitIgnoreEntriesFromCommands,
} from "../src/steps/local-gitignore";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveLocalGitIgnoreEntriesFromCommands", () => {
  it("extracts build directories from cmake/ctest commands", () => {
    const entries = resolveLocalGitIgnoreEntriesFromCommands([
      "cmake -S cmake -B build-headless -DTIGERENGINE_BUILD_TESTS=ON",
      "cmake --build build-headless",
      "ctest --test-dir build-headless --output-on-failure",
    ]);
    expect(entries).toEqual(["build-headless/"]);
  });

  it("supports inline flag values and deduplicates entries", () => {
    const entries = resolveLocalGitIgnoreEntriesFromCommands([
      "cmake -Bcmake-build-debug",
      "ctest --test-dir=cmake-build-debug",
      "cmake --build=build/verify",
    ]);
    expect(entries).toEqual(["cmake-build-debug/", "build/verify/"]);
  });

  it("ignores unsafe path values", () => {
    const entries = resolveLocalGitIgnoreEntriesFromCommands([
      "cmake --build /tmp/build-headless",
      "ctest --test-dir ../build-headless",
      "cmake -B ../../unsafe",
    ]);
    expect(entries).toEqual([]);
  });
});

describe("ensureLocalGitIgnoreEntries", () => {
  it("writes entries to .git/info/exclude in normal repositories", async () => {
    const repoPath = await makeTempDir("opentiger-local-ignore-");
    await mkdir(join(repoPath, ".git", "info"), { recursive: true });
    await writeFile(join(repoPath, ".git", "info", "exclude"), "# existing\n", "utf-8");

    const result = await ensureLocalGitIgnoreEntries({
      repoPath,
      commands: ["cmake -B build-headless"],
    });

    expect(result.success).toBe(true);
    expect(result.addedEntries).toEqual(["build-headless/"]);
    const excludeContent = await readFile(join(repoPath, ".git", "info", "exclude"), "utf-8");
    expect(excludeContent).toContain("build-headless/");
  });

  it("resolves .git/info/exclude path for worktree-style .git files", async () => {
    const repoPath = await makeTempDir("opentiger-local-ignore-worktree-");
    const gitDir = await makeTempDir("opentiger-local-ignore-gitdir-");
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), "", "utf-8");
    await writeFile(join(repoPath, ".git"), `gitdir: ${gitDir}\n`, "utf-8");

    const excludePath = await resolveGitInfoExcludePath(repoPath);
    expect(excludePath).toBe(join(gitDir, "info", "exclude"));

    const result = await ensureLocalGitIgnoreEntries({
      repoPath,
      commands: ["ctest --test-dir build-headless"],
    });
    expect(result.success).toBe(true);
    const excludeContent = await readFile(join(gitDir, "info", "exclude"), "utf-8");
    expect(excludeContent).toContain("build-headless/");
  });
});
