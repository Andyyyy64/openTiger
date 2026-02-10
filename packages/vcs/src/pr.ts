import { getOctokit, getRepoInfo } from "./client";

// PR検索オプション
export interface SearchPROptions {
  head?: string;
  base?: string;
  state?: "open" | "closed" | "all";
}

// PR作成オプション
export interface CreatePROptions {
  title: string;
  body: string;
  head: string; // ソースブランチ
  base?: string; // ターゲットブランチ（デフォルト: main）
  labels?: string[];
  draft?: boolean;
}

// PR情報
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

function isRecoverableServerError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return typeof status === "number" && status >= 500;
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

// PRを検索
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

// PRを更新
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
    // GitHub一時障害時は既存PRを維持して処理継続する
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

  // ラベルを更新（既存のラベルに追加）
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
      // ラベル付与失敗は致命扱いにしない
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

// PRを作成
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
    // 作成成功直後のレスポンス失敗を救済するため、同一head/baseの既存PRを再検索する
    console.warn(
      `[VCS] pull create failed with recoverable server error for head=${options.head}; searching existing PR.`,
      error,
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
    throw error;
  }

  // ラベルを追加
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
      // ラベル付与失敗は致命扱いにしない
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

// PRにコメントを追加
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

// PRをマージ
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

// PRを閉じる
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

// PRのCIステータスを取得
export async function getPRCIStatus(prNumber: number): Promise<"success" | "failure" | "pending"> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  // PRの情報を取得
  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  // コミットのステータスを取得
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
