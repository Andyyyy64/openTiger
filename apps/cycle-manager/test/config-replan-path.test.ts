import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TRACKED_ENV_KEYS = [
  "OPENTIGER_REQUIREMENT_REPO_ROOT",
  "REPLAN_REQUIREMENT_PATH",
  "REQUIREMENT_PATH",
  "REPLAN_REPO_URL",
  "REPO_URL",
  "REPLAN_WORKDIR",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

const tempDirs: string[] = [];

async function loadDefaultConfig() {
  vi.resetModules();
  const mod = await import("../src/main/config.ts");
  return mod.DEFAULT_CONFIG;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of TRACKED_ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cycle-manager requirement path resolution", () => {
  it("prefers managed git requirement path even when REPLAN_* env vars are empty", async () => {
    const managedRoot = createTempDir("ot-managed-repo-");
    const managedRequirementPath = resolve(
      managedRoot,
      "Andyyyy64",
      "tigerEngine",
      "docs",
      "requirement.md",
    );
    mkdirSync(resolve(managedRequirementPath, ".."), { recursive: true });
    writeFileSync(managedRequirementPath, "# requirement");

    process.env.OPENTIGER_REQUIREMENT_REPO_ROOT = managedRoot;
    process.env.REPLAN_REQUIREMENT_PATH = "docs/requirement.md";
    process.env.REPLAN_REPO_URL = "";
    process.env.REPLAN_WORKDIR = "";
    process.env.REPO_URL = "https://github.com/Andyyyy64/tigerEngine";

    const config = await loadDefaultConfig();
    expect(config.replanRequirementPath).toBe(managedRequirementPath);
    expect(config.replanRepoUrl).toBe("https://github.com/Andyyyy64/tigerEngine");
  });

  it("falls back to local workdir path when managed requirement path is unavailable", async () => {
    const managedRoot = createTempDir("ot-managed-empty-");
    const workdir = createTempDir("ot-replan-workdir-");
    const localRequirementPath = resolve(workdir, "docs", "requirement.md");
    mkdirSync(resolve(localRequirementPath, ".."), { recursive: true });
    writeFileSync(localRequirementPath, "# local requirement");

    process.env.OPENTIGER_REQUIREMENT_REPO_ROOT = managedRoot;
    process.env.REPLAN_REQUIREMENT_PATH = "docs/requirement.md";
    process.env.REPLAN_WORKDIR = workdir;
    process.env.REPLAN_REPO_URL = "";
    process.env.REPO_URL = "https://github.com/Andyyyy64/tigerEngine";

    const config = await loadDefaultConfig();
    expect(config.replanRequirementPath).toBe(localRequirementPath);
  });
});
