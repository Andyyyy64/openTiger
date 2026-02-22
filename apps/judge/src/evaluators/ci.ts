import { getOctokit, getRepoInfo } from "@openTiger/vcs";

// CI evaluation result
export interface CIEvaluationResult {
  pass: boolean;
  status: "success" | "failure" | "pending" | "error";
  reasons: string[];
  suggestions: string[];
  details: CICheckDetail[];
}

// Individual CI check detail
export interface CICheckDetail {
  name: string;
  status: "success" | "failure" | "pending" | "skipped";
  conclusion: string | null;
  url: string | null;
}

// Get CI status for a PR
export async function getCIStatus(prNumber: number): Promise<{
  status: "success" | "failure" | "pending" | "error";
  checks: CICheckDetail[];
}> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  let checks: CICheckDetail[] = [];

  try {
    // Get PR information
    const pr = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const headSha = pr.data.head.sha;

    // Get Check Runs
    try {
      const checkRuns = await octokit.checks.listForRef({
        owner,
        repo,
        ref: headSha,
      });

      // Collect Check Run details
      checks = checkRuns.data.check_runs.map((run) => ({
        name: run.name,
        status: mapCheckStatus(run.status, run.conclusion),
        conclusion: run.conclusion,
        url: run.html_url,
      }));
    } catch (error) {
      console.warn("Failed to list check runs, falling back to combined status.", error);
    }

    // Also get Combined Status (for the legacy status API)
    const combinedStatus = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });

    // Add statuses from the Combined Status
    for (const status of combinedStatus.data.statuses) {
      checks.push({
        name: status.context,
        status: mapCombinedStatus(status.state),
        conclusion: status.state,
        url: status.target_url,
      });
    }

    // Determine overall status
    const hasFailure = checks.some((c) => c.status === "failure");
    const hasPending = checks.some((c) => c.status === "pending");

    let overallStatus: "success" | "failure" | "pending" | "error";
    if (hasFailure) {
      overallStatus = "failure";
    } else if (hasPending) {
      overallStatus = "pending";
    } else if (checks.length === 0) {
      // Treat as success when there are no checks
      overallStatus = "success";
    } else {
      overallStatus = "success";
    }

    return { status: overallStatus, checks };
  } catch (error) {
    console.error("Failed to get CI status:", error);
    return {
      status: "error",
      checks: [],
    };
  }
}

// Map Check Run status
function mapCheckStatus(
  status: string,
  conclusion: string | null,
): "success" | "failure" | "pending" | "skipped" {
  if (status !== "completed") {
    return "pending";
  }

  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
      return "failure";
    case "skipped":
    case "neutral":
      return "skipped";
    default:
      return "pending";
  }
}

// Map Combined Status state
function mapCombinedStatus(state: string): "success" | "failure" | "pending" | "skipped" {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "pending";
  }
}

// Evaluate CI results
export async function evaluateCI(prNumber: number): Promise<CIEvaluationResult> {
  const { status, checks } = await getCIStatus(prNumber);

  const reasons: string[] = [];
  const suggestions: string[] = [];

  switch (status) {
    case "pending":
      reasons.push("CI is still running");
      suggestions.push("Wait for CI to complete before reviewing");
      break;

    case "failure":
      reasons.push("CI checks have failed");
      // Add details of failed checks
      const failedChecks = checks.filter((c) => c.status === "failure");
      for (const check of failedChecks) {
        reasons.push(`  - ${check.name}: ${check.conclusion}`);
      }
      suggestions.push("Fix the failing tests and push again");
      break;

    case "error":
      reasons.push("Failed to retrieve CI status");
      suggestions.push("Check GitHub API access and try again");
      break;
  }

  return {
    pass: status === "success",
    status,
    reasons,
    suggestions,
    details: checks,
  };
}
