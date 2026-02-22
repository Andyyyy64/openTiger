import type { Policy } from "@openTiger/core";
import { getOctokit, getRepoInfo } from "@openTiger/vcs";

// Policy evaluation result
export interface PolicyEvaluationResult {
  pass: boolean;
  reasons: string[];
  suggestions: string[];
  violations: PolicyViolation[];
}

// Policy violation details
export interface PolicyViolation {
  type: "lines" | "files" | "path" | "command" | "pattern";
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

// Get PR diff statistics
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

// Check if a path matches a pattern
function matchPath(path: string, pattern: string): boolean {
  // Safely convert glob wildcards to regular expressions
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
  return (
    path === "package.json" || path.endsWith("/package.json") || path === "pnpm-workspace.yaml"
  );
}

// Check if a path is allowed
function isPathAllowed(path: string, allowedPaths: string[], forbiddenPaths: string[]): boolean {
  // Deny if the path matches a forbidden path
  for (const forbidden of forbiddenPaths) {
    if (matchPath(path, forbidden)) {
      return false;
    }
  }

  // If allowed paths are specified, the path must match at least one
  if (allowedPaths.length > 0) {
    return allowedPaths.some((allowed) => matchPath(path, allowed));
  }

  return true;
}

// Evaluate policy
export async function evaluatePolicy(
  prNumber: number,
  policy: Policy,
  allowedPaths: string[] = [],
): Promise<PolicyEvaluationResult> {
  const violations: PolicyViolation[] = [];
  const reasons: string[] = [];
  const suggestions: string[] = [];

  try {
    const diffStats = await getPRDiffStats(prNumber);
    const hasManifestChanges = diffStats.files.some((file) => isPackageManifest(file.filename));

    // Check file paths
    for (const file of diffStats.files) {
      // Allow lockfile changes that accompany dependency updates
      if (isLockfile(file.filename) && hasManifestChanges) {
        continue;
      }
      // Changes to forbidden paths
      if (!isPathAllowed(file.filename, allowedPaths, policy.deniedPaths)) {
        violations.push({
          type: "path",
          severity: "error",
          message: `Changes to forbidden path: ${file.filename}`,
          file: file.filename,
        });
      }
    }

    // Convert violations to reasons
    for (const violation of violations) {
      if (violation.severity === "error") {
        reasons.push(violation.message);
      }
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

// Evaluate risk level
export function evaluateRiskLevel(
  diffStats: {
    additions: number;
    deletions: number;
    changedFiles: number;
    files: Array<{ filename: string }>;
  },
  policy: Policy,
): "low" | "medium" | "high" {
  const totalChanges = diffStats.additions + diffStats.deletions;

  // 1. Base risk determined by change volume
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

  // 2. Escalate risk based on sensitive file paths
  const sensitivePatterns = [
    "**/auth/**",
    "**/security/**",
    "**/db/schema.ts",
    "**/.github/workflows/**",
    "package.json",
    "pnpm-lock.yaml",
  ];

  const touchesSensitiveFile = diffStats.files.some((file) =>
    sensitivePatterns.some((pattern) => matchPath(file.filename, pattern)),
  );

  if (touchesSensitiveFile) {
    // If sensitive files are touched, set minimum risk to medium
    if (risk === "low") {
      risk = "medium";
    }
    // If already medium, escalate to high
    else if (risk === "medium") {
      risk = "high";
    }
  }

  return risk;
}
