import type {
  FailureCategory as SharedFailureCategory,
  FailureClassification as SharedFailureClassification,
} from "@openTiger/core";

export type BlockReason = "awaiting_judge" | "needs_rework" | "quota_wait";

export type FailureCategory = SharedFailureCategory;

export type FailureClassification = SharedFailureClassification & {
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
