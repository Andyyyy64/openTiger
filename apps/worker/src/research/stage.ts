export type ResearchStage = "plan" | "collect" | "challenge" | "write";

export function normalizeResearchStage(value: string | undefined): ResearchStage {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "plan" ||
    normalized === "planning" ||
    normalized === "decompose" ||
    normalized === "decomposition"
  ) {
    return "plan";
  }
  if (
    normalized === "challenge" ||
    normalized === "challenging" ||
    normalized === "counter" ||
    normalized === "countercheck"
  ) {
    return "challenge";
  }
  if (
    normalized === "write" ||
    normalized === "compose" ||
    normalized === "composing" ||
    normalized === "report"
  ) {
    return "write";
  }
  return "collect";
}

export function isWriteStage(stage: ResearchStage): boolean {
  return stage === "write";
}
