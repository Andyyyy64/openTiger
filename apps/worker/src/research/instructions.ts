import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Task } from "@openTiger/core";
import type { ResearchInstructionProfile } from "./types";
import { normalizeResearchStage } from "./stage";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function resolveProfileFromStage(stage: string | undefined): ResearchInstructionProfile {
  const normalized = normalizeResearchStage(stage);
  if (normalized === "challenge") {
    return "challenger";
  }
  if (normalized === "write") {
    return "writer";
  }
  // plan/collect stages both use researcher profile.
  return "researcher";
}

export function resolveResearchInstructionsPath(stage: string | undefined): string {
  const profile = resolveProfileFromStage(stage);
  const relativePath = `research/${profile}.md`;
  const candidates = [
    resolve(import.meta.dirname, `../../instructions/${relativePath}`),
    resolve(import.meta.dirname, `../instructions/${relativePath}`),
  ];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0]!;
}

export function resolveResearchInstructionsPathFromTask(task: Task): string {
  const context = asRecord(task.context);
  const research = asRecord(context.research);
  const stage = typeof research.stage === "string" ? research.stage : undefined;
  return resolveResearchInstructionsPath(stage);
}
