import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { PlannerConfig } from "./planner-config";

// Plannerが参照する作業ディレクトリを用意
export async function preparePlannerWorkdir(config: PlannerConfig): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  if (!config.repoUrl) {
    console.log(`[Planner] Using local workdir: ${config.workdir}`);
    return {
      workdir: config.workdir,
      cleanup: async () => undefined,
    };
  }

  console.log(`[Planner] Using remote repo: ${config.repoUrl}`);
  const tempDir = await mkdtemp(join(tmpdir(), "openTiger-planner-"));
  const repoDir = join(tempDir, "repo");
  const token = process.env.GITHUB_TOKEN;
  const cloneResult = await gitCloneRepo(config.repoUrl, repoDir, token, config.baseBranch);

  if (!cloneResult.success) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Planner failed to clone repo: ${cloneResult.stderr}`);
  }

  return {
    workdir: repoDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function gitCloneRepo(
  repoUrl: string,
  destPath: string,
  token?: string,
  baseBranch?: string,
): Promise<{ success: boolean; stderr: string }> {
  let authenticatedUrl = repoUrl;
  if (token && repoUrl.startsWith("https://github.com/")) {
    authenticatedUrl = repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${token}@github.com/`,
    );
  }

  const runClone = (args: string[]) =>
    new Promise<{ success: boolean; stderr: string }>((resolveResult) => {
      const child = spawn("git", args, {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // 認証待ちで止めない
        },
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        resolveResult({
          success: code === 0,
          stderr: stderr.trim(),
        });
      });

      child.on("error", (error) => {
        resolveResult({
          success: false,
          stderr: error.message,
        });
      });
    });

  const args = ["clone", "--depth", "1"];
  if (baseBranch) {
    args.push("--branch", baseBranch);
  }
  args.push(authenticatedUrl, destPath);

  const result = await runClone(args);
  if (result.success || !baseBranch) {
    return result;
  }

  console.warn(`[Planner] Failed to clone branch ${baseBranch}, retrying default branch`);

  return runClone(["clone", "--depth", "1", authenticatedUrl, destPath]);
}
