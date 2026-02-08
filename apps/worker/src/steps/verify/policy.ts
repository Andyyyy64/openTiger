import type { Policy } from "@openTiger/core";
import { matchesPattern } from "./paths";

// ポリシー違反をチェック
export function checkPolicyViolations(
  changedFiles: string[],
  stats: { additions: number; deletions: number },
  allowedPaths: string[],
  policy: Policy,
): string[] {
  const violations: string[] = [];

  // 変更行数チェック
  const totalChanges = stats.additions + stats.deletions;
  if (totalChanges > policy.maxLinesChanged) {
    violations.push(`Too many lines changed: ${totalChanges} (max: ${policy.maxLinesChanged})`);
  }

  // 変更ファイル数チェック
  if (changedFiles.length > policy.maxFilesChanged) {
    violations.push(
      `Too many files changed: ${changedFiles.length} (max: ${policy.maxFilesChanged})`,
    );
  }

  // 許可パス外の変更チェック
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
