import { randomUUID } from "node:crypto";
import type { Task } from "@openTiger/core";
import type { ResearchInput } from "./types";
import { normalizeResearchStage } from "./stage";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveResearchInput(task: Task): ResearchInput {
  const context = asRecord(task.context);
  const research = asRecord(context.research);
  const jobId = asString(research.jobId) ?? randomUUID();

  const query =
    asString(research.query) ?? asString(research.claimText) ?? `${task.title}\n\n${task.goal}`;

  return {
    jobId,
    query,
    stage: normalizeResearchStage(asString(research.stage)),
    profile: asString(research.profile) ?? "mid",
    claimId: asString(research.claimId),
    claimText: asString(research.claimText),
    claims: asStringArray(research.claims),
  };
}
