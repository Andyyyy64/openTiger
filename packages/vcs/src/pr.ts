import { getOctokit, getRepoInfo } from "./client";

// Options for searching PRs
export interface SearchPROptions {
  head?: string;
  base?: string;
  state?: "open" | "closed" | "all";
}

// Options for creating a PR
export interface CreatePROptions {
  title: string;
  body: string;
  head: string; // source branch
  base?: string; // target branch (default: main)
  labels?: string[];
  draft?: boolean;
}

// PR information
export interface PRInfo {
  number: number;
  url: string;
  title: string;
  state: string;
}

export interface MergePRResult {
  merged: boolean;
  status?: number;
  reason?: string;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status)) {
      return status;
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "");
}

function isRecoverableServerError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (typeof status === "number" && status >= 500) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    const message = getErrorMessage(error).toLowerCase();
    return message.includes("rate limit") || message.includes("secondary rate limit");
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackPRInfo(params: {
  owner: string;
  repo: string;
  prNumber: number;
  title?: string;
}): PRInfo {
  return {
    number: params.prNumber,
    url: `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}`,
    title: params.title ?? `PR #${params.prNumber}`,
    state: "open",
  };
}

// Search for PRs
export async function findPRs(options: SearchPROptions): Promise<PRInfo[]> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.pulls.list({
    owner,
    repo,
    head: options.head ? `${owner}:${options.head}` : undefined,
    base: options.base,
    state: options.state ?? "open",
  });

  return response.data.map((pr) => ({
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
  }));
}

// Update a PR
export async function updatePR(
  prNumber: number,
  options: Partial<CreatePROptions>,
): Promise<PRInfo> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  let response: Awaited<ReturnType<typeof octokit.pulls.update>> | null = null;
  try {
    response = await octokit.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      title: options.title,
      body: options.body,
      state: "open",
    });
  } catch (error) {
    if (!isRecoverableServerError(error)) {
      throw error;
    }
    // Keep existing PR and continue when GitHub has a temporary outage
    console.warn(
      `[VCS] pull update failed with recoverable server error for #${prNumber}; keeping existing PR.`,
      error,
    );
    return fallbackPRInfo({
      owner,
      repo,
      prNumber,
      title: options.title,
    });
  }

  // Update labels (add to existing labels)
  if (options.labels && options.labels.length > 0) {
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: options.labels,
      });
    } catch (error) {
      if (!isRecoverableServerError(error)) {
        throw error;
      }
      // Don't treat label assignment failure as fatal
      console.warn(
        `[VCS] addLabels failed with recoverable server error for PR #${prNumber}; continuing.`,
        error,
      );
    }
  }

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title,
    state: response.data.state,
  };
}

// Create a PR
export async function createPR(options: CreatePROptions): Promise<PRInfo> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  let response: Awaited<ReturnType<typeof octokit.pulls.create>> | null = null;
  try {
    response = await octokit.pulls.create({
      owner,
      repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base ?? "main",
      draft: options.draft ?? false,
    });
  } catch (error) {
    if (!isRecoverableServerError(error)) {
      throw error;
    }
    await sleep(1500);
    try {
      response = await octokit.pulls.create({
        owner,
        repo,
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base ?? "main",
        draft: options.draft ?? false,
      });
    } catch (retryError) {
      if (!isRecoverableServerError(retryError)) {
        throw retryError;
      }
      // Search for existing PR with same head/base to recover when response fails right after create
      console.warn(
        `[VCS] pull create failed with recoverable server error for head=${options.head}; searching existing PR.`,
        retryError,
      );
      const existing = await findPRs({
        head: options.head,
        base: options.base ?? "main",
        state: "open",
      });
      const matched = existing[0];
      if (matched) {
        return matched;
      }
      throw retryError;
    }
  }

  // Add labels
  if (options.labels && options.labels.length > 0) {
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: response.data.number,
        labels: options.labels,
      });
    } catch (error) {
      if (!isRecoverableServerError(error)) {
        throw error;
      }
      // Don't treat label assignment failure as fatal
      console.warn(
        `[VCS] addLabels failed with recoverable server error for PR #${response.data.number}; continuing.`,
        error,
      );
    }
  }

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title,
    state: response.data.state,
  };
}

// Add a comment to a PR
export async function addPRComment(prNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

// Merge a PR
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Unknown error");
  }
  return String(error);
}

export async function mergePR(
  prNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<MergePRResult> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  try {
    await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: mergeMethod,
    });
    return { merged: true };
  } catch (error) {
    console.error(`Failed to merge PR #${prNumber}:`, error);
    return {
      merged: false,
      status: getErrorStatus(error),
      reason: extractErrorMessage(error),
    };
  }
}

// Close a PR
export async function closePR(prNumber: number): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    state: "closed",
  });
}

// Get PR CI status
export async function getPRCIStatus(prNumber: number): Promise<"success" | "failure" | "pending"> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  // Fetch PR info
  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  // Fetch commit status
  const status = await octokit.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref: pr.data.head.sha,
  });

  switch (status.data.state) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    default:
      return "pending";
  }
}
