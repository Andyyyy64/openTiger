import type { BlockReason, NormalizedContext } from "./types";

export function normalizeBlockReason(reason: string | null): BlockReason | null {
  if (reason === "needs_human") {
    // legacy互換: needs_humanはawaiting_judgeとして回収する
    return "awaiting_judge";
  }
  if (reason === "awaiting_judge" || reason === "needs_rework" || reason === "quota_wait") {
    return reason;
  }
  return null;
}

export function normalizeContext(context: unknown): NormalizedContext {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }
  return context as NormalizedContext;
}

export function isPrReviewTask(params: { title: string; goal: string; context: unknown }): boolean {
  if (params.goal.startsWith("Review and process open PR #")) {
    return true;
  }
  if (params.title.startsWith("[PR] Review #")) {
    return true;
  }
  const context = normalizeContext(params.context);
  if (typeof context.pr?.number === "number") {
    return true;
  }
  if (typeof context.issue?.number === "number" && params.title.startsWith("[PR]")) {
    return true;
  }
  return context.notes?.includes("Imported from open GitHub PR backlog") === true;
}
