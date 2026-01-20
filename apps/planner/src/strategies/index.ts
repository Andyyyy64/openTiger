// ストラテジーモジュールのエクスポート

export {
  generateTasksFromRequirement,
  generateSimpleTasks,
  type TaskGenerationResult,
} from "./from-requirement.js";

export {
  generateTasksFromIssue,
  generateSimpleTaskFromIssue,
  type GitHubIssue,
  type IssueAnalysisResult,
} from "./from-issue.js";
