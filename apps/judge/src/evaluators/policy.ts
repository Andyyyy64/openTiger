import type { Policy } from "@sebastian-code/core";
import { getOctokit, getRepoInfo } from "@sebastian-code/vcs";

// ポリシー評価結果
export interface PolicyEvaluationResult {
  pass: boolean;
  reasons: string[];
  suggestions: string[];
  violations: PolicyViolation[];
}

// ポリシー違反の詳細
export interface PolicyViolation {
  type: "lines" | "files" | "path" | "command" | "pattern";
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

// PRのdiff統計を取得
export async function getPRDiffStats(prNumber: number): Promise<{
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
}> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const files = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return {
    additions: pr.data.additions,
    deletions: pr.data.deletions,
    changedFiles: pr.data.changed_files,
    files: files.data.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    })),
  };
}

// パスがパターンにマッチするか
function matchPath(path: string, pattern: string): boolean {
  // globのワイルドカードを正規表現に安全に変換する
  let regexPattern = "";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (!char) {
      continue;
    }

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexPattern += ".*";
        i++;
        continue;
      }
      regexPattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      regexPattern += ".";
      continue;
    }

    regexPattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${regexPattern}$`).test(path);
}

function isLockfile(path: string): boolean {
  return path === "pnpm-lock.yaml";
}

function isPackageManifest(path: string): boolean {
  return path === "package.json"
    || path.endsWith("/package.json")
    || path === "pnpm-workspace.yaml";
}

// パスが許可されているか
function isPathAllowed(
  path: string,
  allowedPaths: string[],
  forbiddenPaths: string[]
): boolean {
  // 禁止パスに該当する場合は不許可
  for (const forbidden of forbiddenPaths) {
    if (matchPath(path, forbidden)) {
      return false;
    }
  }

  // 許可パスが指定されている場合は、いずれかにマッチする必要がある
  if (allowedPaths.length > 0) {
    return allowedPaths.some((allowed) => matchPath(path, allowed));
  }

  return true;
}

// ポリシーを評価
export async function evaluatePolicy(
  prNumber: number,
  policy: Policy,
  allowedPaths: string[] = []
): Promise<PolicyEvaluationResult> {
  const violations: PolicyViolation[] = [];
  const reasons: string[] = [];
  const suggestions: string[] = [];

  try {
    const diffStats = await getPRDiffStats(prNumber);
    const hasManifestChanges = diffStats.files.some((file) =>
      isPackageManifest(file.filename)
    );

    // 変更行数のチェック
    const totalChanges = diffStats.additions + diffStats.deletions;
    if (totalChanges > policy.maxLinesChanged) {
      violations.push({
        type: "lines",
        severity: "error",
        message: `Changes exceed maximum allowed lines (${totalChanges} > ${policy.maxLinesChanged})`,
      });
    }

    // 変更ファイル数のチェック
    if (diffStats.changedFiles > policy.maxFilesChanged) {
      violations.push({
        type: "files",
        severity: "error",
        message: `Changed files exceed maximum allowed (${diffStats.changedFiles} > ${policy.maxFilesChanged})`,
      });
    }

    // ファイルパスのチェック
    for (const file of diffStats.files) {
      // 依存更新に伴うロックファイル変更は許容する
      if (isLockfile(file.filename) && hasManifestChanges) {
        continue;
      }
      // 禁止パスへの変更
      if (!isPathAllowed(file.filename, allowedPaths, policy.deniedPaths)) {
        violations.push({
          type: "path",
          severity: "error",
          message: `Changes to forbidden path: ${file.filename}`,
          file: file.filename,
        });
      }
    }

    // 違反を理由に変換
    for (const violation of violations) {
      if (violation.severity === "error") {
        reasons.push(violation.message);
      }
    }

    // 改善提案
    if (violations.some((v) => v.type === "lines")) {
      suggestions.push("Consider splitting this PR into smaller changes");
    }

    if (violations.some((v) => v.type === "path")) {
      suggestions.push("Move changes to allowed paths or request path permission");
    }
  } catch (error) {
    console.error("Failed to evaluate policy:", error);
    reasons.push("Failed to retrieve PR diff information");
  }

  return {
    pass: violations.filter((v) => v.severity === "error").length === 0,
    reasons,
    suggestions,
    violations,
  };
}

// リスクレベルを評価
export function evaluateRiskLevel(
  diffStats: {
    additions: number;
    deletions: number;
    changedFiles: number;
    files: Array<{ filename: string }>;
  },
  policy: Policy
): "low" | "medium" | "high" {
  const totalChanges = diffStats.additions + diffStats.deletions;

  // 1. 変更量によるベースリスク
  let risk: "low" | "medium" | "high" = "low";

  if (
    totalChanges > policy.maxLinesChanged * 0.5 ||
    diffStats.changedFiles > policy.maxFilesChanged * 0.5
  ) {
    risk = "high";
  } else if (
    totalChanges > policy.maxLinesChanged * 0.25 ||
    diffStats.changedFiles > policy.maxFilesChanged * 0.25
  ) {
    risk = "medium";
  }

  // 2. 機微なファイルパスによるリスク格上げ
  const sensitivePatterns = [
    "**/auth/**",
    "**/security/**",
    "**/db/schema.ts",
    "**/.github/workflows/**",
    "package.json",
    "pnpm-lock.yaml",
  ];

  const touchesSensitiveFile = diffStats.files.some((file) =>
    sensitivePatterns.some((pattern) => matchPath(file.filename, pattern))
  );

  if (touchesSensitiveFile) {
    // 機微なファイルを触っている場合は最低でも medium
    if (risk === "low") {
      risk = "medium";
    }
    // すでに medium なら high に格上げ
    else if (risk === "medium") {
      risk = "high";
    }
  }

  return risk;
}
