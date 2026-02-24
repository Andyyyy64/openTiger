import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { getRepoMode, getLocalRepoPath } from "@openTiger/core";

// Planner configuration
export interface PlannerConfig {
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  dryRun: boolean;
  timeoutSeconds: number;
  inspectCodebase: boolean;
  inspectionTimeoutSeconds: number;
  repoUrl?: string;
  baseBranch: string;
}

const envPath = process.env.DOTENV_CONFIG_PATH ?? resolve(import.meta.dirname, "../../../.env");
dotenv.config({ path: envPath });

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolvePlannerWorkdir(): string {
  const repoMode = getRepoMode();
  const localRepoPath = getLocalRepoPath();
  // In local mode, use the actual repository as the inspection target
  if ((repoMode === "local-git" || repoMode === "direct") && localRepoPath) {
    return localRepoPath;
  }
  // Reference the repository root even if the startup directory is under apps
  const gitRoot = resolveGitRoot(process.cwd());
  return gitRoot ?? process.cwd();
}

function resolveGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf-8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? root : undefined;
}

// Default configuration
export const DEFAULT_CONFIG: PlannerConfig = {
  workdir: resolvePlannerWorkdir(),
  instructionsPath: resolve(import.meta.dirname, "../instructions/planning.md"),
  useLlm: parseBoolean(process.env.USE_LLM, true),
  dryRun: parseBoolean(process.env.DRY_RUN, false),
  timeoutSeconds: parseInt(process.env.PLANNER_TIMEOUT ?? "1200", 10),
  inspectCodebase: parseBoolean(process.env.PLANNER_INSPECT, true),
  inspectionTimeoutSeconds: parseInt(process.env.PLANNER_INSPECT_TIMEOUT ?? "1200", 10),
  repoUrl: (() => {
    const plannerRepoUrl = process.env.PLANNER_REPO_URL?.trim();
    if (plannerRepoUrl) {
      return plannerRepoUrl;
    }
    const useRemote = parseBoolean(process.env.PLANNER_USE_REMOTE, true);
    return useRemote ? process.env.REPO_URL : undefined;
  })(),
  baseBranch: process.env.BASE_BRANCH ?? "main",
};
