import type { Policy } from "@openTiger/core";
import type { CIEvaluationResult } from "./ci";
import type { PolicyEvaluationResult, PolicyViolation } from "./policy";
import { getDiffBetweenRefs, getDiffStatsBetweenRefs } from "@openTiger/vcs";

export interface LocalDiffStats {
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
}

export async function getLocalDiffStats(
  worktreePath: string,
  baseBranch: string,
  headBranch: string
): Promise<LocalDiffStats> {
  return getDiffStatsBetweenRefs(worktreePath, baseBranch, headBranch);
}

export async function getLocalDiffText(
  worktreePath: string,
  baseBranch: string,
  headBranch: string
): Promise<string> {
  const result = await getDiffBetweenRefs(worktreePath, baseBranch, headBranch);
  return result.success ? result.stdout : "";
}

// ローカルはCIの代わりにWorker検証を通過している前提で扱う
export function evaluateLocalCI(): CIEvaluationResult {
  return {
    pass: true,
    status: "success",
    reasons: [],
    suggestions: [],
    details: [
      {
        name: "worker.verify",
        status: "success",
        conclusion: "success",
        url: null,
      },
    ],
  };
}

// パスがパターンにマッチするか
function matchPath(path: string, pattern: string): boolean {
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

function isPathAllowed(
  path: string,
  allowedPaths: string[],
  forbiddenPaths: string[]
): boolean {
  for (const forbidden of forbiddenPaths) {
    if (matchPath(path, forbidden)) {
      return false;
    }
  }

  if (allowedPaths.length > 0) {
    return allowedPaths.some((allowed) => matchPath(path, allowed));
  }

  return true;
}

export async function evaluateLocalPolicy(
  worktreePath: string,
  baseBranch: string,
  headBranch: string,
  policy: Policy,
  allowedPaths: string[] = []
): Promise<PolicyEvaluationResult> {
  const violations: PolicyViolation[] = [];
  const reasons: string[] = [];
  const suggestions: string[] = [];

  try {
    const diffStats = await getLocalDiffStats(worktreePath, baseBranch, headBranch);
    const hasManifestChanges = diffStats.files.some((file) =>
      isPackageManifest(file.filename)
    );

    const totalChanges = diffStats.additions + diffStats.deletions;
    if (totalChanges > policy.maxLinesChanged) {
      violations.push({
        type: "lines",
        severity: "error",
        message: `Changes exceed maximum allowed lines (${totalChanges} > ${policy.maxLinesChanged})`,
      });
    }

    if (diffStats.changedFiles > policy.maxFilesChanged) {
      violations.push({
        type: "files",
        severity: "error",
        message: `Changed files exceed maximum allowed (${diffStats.changedFiles} > ${policy.maxFilesChanged})`,
      });
    }

    for (const file of diffStats.files) {
      if (isLockfile(file.filename) && hasManifestChanges) {
        continue;
      }
      if (!isPathAllowed(file.filename, allowedPaths, policy.deniedPaths)) {
        violations.push({
          type: "path",
          severity: "error",
          message: `Changes to forbidden path: ${file.filename}`,
          file: file.filename,
        });
      }
    }

    for (const violation of violations) {
      if (violation.severity === "error") {
        reasons.push(violation.message);
      }
    }

    if (violations.some((v) => v.type === "lines")) {
      suggestions.push("Consider splitting this change into smaller parts");
    }

    if (violations.some((v) => v.type === "path")) {
      suggestions.push("Move changes to allowed paths or request path permission");
    }
  } catch (error) {
    console.error("Failed to evaluate local policy:", error);
    reasons.push("Failed to retrieve diff information");
  }

  return {
    pass: violations.filter((v) => v.severity === "error").length === 0,
    reasons,
    suggestions,
    violations,
  };
}
