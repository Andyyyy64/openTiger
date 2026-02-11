export type BlockReason = "awaiting_judge" | "needs_rework" | "quota_wait";

export type FailureCategory =
  | "env"
  | "setup"
  | "permission"
  | "noop"
  | "policy"
  | "test"
  | "flaky"
  | "model"
  | "model_loop";

export type FailureClassification = {
  category: FailureCategory;
  retryable: boolean;
  reason: string;
  blockReason: Extract<BlockReason, "needs_rework">;
};

export type NormalizedContext = {
  files?: string[];
  specs?: string;
  notes?: string;
  pr?: {
    number: number;
    url?: string;
    title?: string;
    sourceTaskId?: string;
    sourceRunId?: string;
    headRef?: string;
    headSha?: string;
    baseRef?: string;
  };
  issue?: { number: number; url?: string; title?: string };
};
