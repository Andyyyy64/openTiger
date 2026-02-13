import type { Task } from "@openTiger/core";
import type { OpenCodeResult } from "@openTiger/llm";
import type { ResearchStage } from "./stage";

export type ResearchInstructionProfile = "researcher" | "challenger" | "writer";

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  source?: string;
}

export interface ResearchInput {
  jobId: string;
  query: string;
  stage: ResearchStage;
  profile: string;
  claimId?: string;
  claimText?: string;
  claims?: string[];
}

export interface ResearchClaimContext {
  id: string;
  claimText: string;
  stance: string;
  confidence: number;
}

export interface ResearchEvidenceContext {
  id: string;
  claimId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  snippet: string | null;
  reliability: number;
  stance: string;
}

export interface ResearchContextSnapshot {
  claims: ResearchClaimContext[];
  evidence: ResearchEvidenceContext[];
}

export interface ResearchClaimOutput {
  text: string;
  confidence: number;
  verdict: "supported" | "mixed" | "refuted";
  evidenceUrls: string[];
}

export interface ResearchSourceOutput {
  url: string;
  title: string;
  reliability: number;
  publishedAt?: string;
  snippets: string[];
}

export interface ResearchModelOutput {
  summary: string;
  confidence: number;
  claims: ResearchClaimOutput[];
  sources: ResearchSourceOutput[];
  limitations: string[];
  nextActions: string[];
}

export interface ResearchExecutionContext {
  task: Task;
  runId: string;
  agentId: string;
  model?: string;
  instructionsPath?: string;
  workspacePath: string;
}

export interface ResearchExecutionResult {
  openCodeResult: OpenCodeResult;
  parsed: ResearchModelOutput;
  searchResults: ResearchSearchResult[];
  warnings: string[];
}
