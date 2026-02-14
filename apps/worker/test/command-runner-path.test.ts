import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommandPath } from "../src/steps/verify/command-runner";

describe("buildCommandPath", () => {
  it("prepends repo-local node_modules/.bin", () => {
    const cwd = "/tmp/repo";
    const delimiter = process.platform === "win32" ? ";" : ":";
    const path = ["/usr/local/bin", "/usr/bin"].join(delimiter);

    const resolved = buildCommandPath(cwd, path);

    expect(resolved?.split(delimiter)[0]).toBe(join(cwd, "node_modules", ".bin"));
  });

  it("removes external node_modules/.bin entries", () => {
    const cwd = "/tmp/repo";
    const delimiter = process.platform === "win32" ? ";" : ":";
    const path = [
      "/home/andy/project/work/opentiger/node_modules/.bin",
      "/usr/local/bin",
      "/usr/bin",
    ].join(delimiter);

    const resolved = buildCommandPath(cwd, path) ?? "";

    expect(resolved).not.toContain("/home/andy/project/work/opentiger/node_modules/.bin");
    expect(resolved).toContain("/usr/local/bin");
  });

  it("keeps node_modules/.bin entries inside repo", () => {
    const cwd = "/tmp/repo";
    const delimiter = process.platform === "win32" ? ";" : ":";
    const path = ["/tmp/repo/node_modules/.bin", "/usr/bin"].join(delimiter);

    const resolved = buildCommandPath(cwd, path) ?? "";

    expect(resolved).toContain("/tmp/repo/node_modules/.bin");
  });
});
