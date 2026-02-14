import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTaskEnv } from "../src/env";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("buildTaskEnv", () => {
  it("prepends current node bin directory to PATH", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const cwd = await mkdtemp(join(tmpdir(), "opentiger-env-test-"));
    tempDirs.push(cwd);

    const env = await buildTaskEnv(cwd);
    const runtimeNodeBin = dirname(process.execPath);
    const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);

    expect(entries[0]).toBe(runtimeNodeBin);
  });

  it("does not duplicate current node bin directory in PATH", async () => {
    const runtimeNodeBin = dirname(process.execPath);
    process.env.PATH = `${runtimeNodeBin}:/usr/bin:/bin`;
    const cwd = await mkdtemp(join(tmpdir(), "opentiger-env-test-"));
    tempDirs.push(cwd);

    const env = await buildTaskEnv(cwd);
    const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
    const count = entries.filter((entry) => entry === runtimeNodeBin).length;

    expect(count).toBe(1);
  });
});
