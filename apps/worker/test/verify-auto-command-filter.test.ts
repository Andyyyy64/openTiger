import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterUnsupportedAutoCommands } from "../src/steps/verify/verify-changes";

const createdDirs: string[] = [];

async function createRepoWithMakefile(content: string): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "opentiger-auto-verify-"));
  createdDirs.push(repoPath);
  await writeFile(join(repoPath, "Makefile"), content, "utf-8");
  return repoPath;
}

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("filterUnsupportedAutoCommands", () => {
  it("drops auto make commands that reference unknown targets", async () => {
    const repoPath = await createRepoWithMakefile("all:\n\t@echo ok\nlint:\n\t@echo lint\n");
    const commands = await filterUnsupportedAutoCommands(repoPath, [
      "make",
      "make lint",
      "make test",
    ]);

    expect(commands).toEqual(["make", "make lint"]);
  });

  it("keeps non-make commands unchanged", async () => {
    const repoPath = await createRepoWithMakefile("all:\n\t@echo ok\n");
    const commands = await filterUnsupportedAutoCommands(repoPath, [
      "pnpm run check",
      "test -f build/kernel.elf",
    ]);

    expect(commands).toEqual(["pnpm run check", "test -f build/kernel.elf"]);
  });

  it("keeps make commands when makefile cannot constrain targets", async () => {
    const repoPath = await createRepoWithMakefile("");
    const commands = await filterUnsupportedAutoCommands(repoPath, ["make test"]);

    expect(commands).toEqual(["make test"]);
  });
});
