import type { Policy } from "@openTiger/core";
import { matchesPattern } from "./paths";

// Check policy violations
export function checkPolicyViolations(
  changedFiles: string[],
  _stats: { additions: number; deletions: number },
  allowedPaths: string[],
  policy: Policy,
): string[] {
  const violations: string[] = [];

  // Check for changes outside allowed paths
  for (const file of changedFiles) {
    const isAllowed = matchesPattern(file, allowedPaths);
    const isDenied = matchesPattern(file, policy.deniedPaths);

    if (isDenied) {
      violations.push(`Change to denied path: ${file}`);
    } else if (!isAllowed) {
      violations.push(`Change outside allowed paths: ${file}`);
    }
  }

  return violations;
}
