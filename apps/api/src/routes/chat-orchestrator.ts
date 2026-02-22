/**
 * Chat orchestrator — builds system prompts and manages conversation phase transitions.
 */

import type { MessageRecord, ConfigRecord } from "@openTiger/db/schema";

export type ConversationPhase =
  | "greeting"
  | "requirement_gathering"
  | "clarification"
  | "plan_proposal"
  | "repo_prompt"
  | "execution"
  | "monitoring";

const GIT_KEYWORDS = /\b(github|git|pr|pull\s*request|issue|merge|branch|commit|repository|repo|push|clone)\b/i;

export function requiresGitSetup(
  messages: Pick<MessageRecord, "content" | "role">[],
  configRow: ConfigRecord | null,
): boolean {
  if (configRow) {
    const repoMode = configRow.repoMode?.toLowerCase();
    if (repoMode === "local") return false;
    if (configRow.githubOwner?.trim() && configRow.githubRepo?.trim()) return false;
  }
  return messages.some((msg) => msg.role === "user" && GIT_KEYWORDS.test(msg.content));
}

export function resolvePhase(
  messages: Pick<MessageRecord, "role" | "content" | "messageType">[],
  metadata: Record<string, unknown> | null,
): ConversationPhase {
  // Only honour metadata.phase for terminal states that are explicitly set via
  // user actions (confirm-plan → execution, configure-repo → repo_prompt).
  // Otherwise, derive the phase from actual message history so it progresses naturally.
  const metaPhase = metadata?.phase;
  if (metaPhase === "execution" || metaPhase === "monitoring") {
    return metaPhase;
  }

  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return "greeting";

  // Check for execution_status messages
  const hasExecution = messages.some((m) => m.messageType === "execution_status");
  if (hasExecution) return "monitoring";

  // Check for plan_proposal messages
  const hasPlan = messages.some((m) => m.messageType === "plan_proposal");
  if (hasPlan) return "plan_proposal";

  // Check for repo_prompt messages
  const hasRepoPrompt = messages.some((m) => m.messageType === "repo_prompt");
  if (hasRepoPrompt) return "repo_prompt";

  if (userMessages.length === 1) return "requirement_gathering";
  if (userMessages.length <= 3) return "clarification";
  return "plan_proposal";
}

const SYSTEM_PROMPTS: Record<ConversationPhase, string> = {
  greeting: `You are openTiger, an autonomous coding orchestration system. You help users plan and execute software development tasks.

Greet the user warmly and ask what they'd like to work on. Keep it concise and terminal-styled.
You can help with:
- Planning and executing code tasks
- Research tasks
- Bug fixes and feature development

Ask what they need help with. Do NOT ask about Git/GitHub setup unless the user mentions it.`,

  requirement_gathering: `You are openTiger's planning assistant. The user is describing what they want to build or fix.

Your job:
1. Understand the requirement clearly
2. Ask clarifying questions if needed
3. When you have enough info, propose a task breakdown

Keep responses concise. Use markdown for structure when helpful.
Do NOT ask about Git/GitHub setup unless the user explicitly mentions needing PR/GitHub integration.`,

  clarification: `You are openTiger's planning assistant. You're clarifying requirements with the user.

Ask specific questions about unclear aspects. Focus on:
- Scope boundaries
- Acceptance criteria
- Risk areas
- Dependencies

Keep it conversational and concise.`,

  plan_proposal: `You are openTiger's planning assistant. Based on the conversation, propose a concrete task breakdown.

Format your response as a plan with:
- Clear task titles
- Brief descriptions
- Estimated risk levels (low/medium/high)
- Suggested execution order

After presenting the plan, ask the user to confirm or adjust it.`,

  repo_prompt: `You are openTiger's configuration assistant. The user's task requires Git/GitHub integration.

Ask them to configure:
1. GitHub owner (organization or username)
2. Repository name
3. Base branch (default: main)

Keep it brief and helpful.`,

  execution: `You are openTiger's execution monitor. Tasks are being executed.

Provide concise status updates about task progress. Report:
- Which tasks are running
- Any failures or retries
- Completed tasks

Keep updates brief and terminal-styled.`,

  monitoring: `You are openTiger's post-execution assistant. Tasks have been completed.

Summarize results and ask if the user needs anything else.`,
};

export function buildSystemPrompt(phase: ConversationPhase): string {
  return SYSTEM_PROMPTS[phase] ?? SYSTEM_PROMPTS.greeting;
}

export function resolveExecutorFromConfig(configRow: ConfigRecord | null): "claude_code" | "codex" | "opencode" {
  const executor = configRow?.llmExecutor?.trim().toLowerCase();
  if (executor === "claude_code" || executor === "codex" || executor === "opencode") {
    return executor;
  }
  return "codex";
}

export function resolveModelFromConfig(
  configRow: ConfigRecord | null,
  executor: "claude_code" | "codex" | "opencode",
): string | undefined {
  if (!configRow) return undefined;
  switch (executor) {
    case "claude_code":
      return configRow.claudeCodeModel?.trim() || undefined;
    case "codex":
      return configRow.codexModel?.trim() || undefined;
    case "opencode":
      return configRow.opencodeModel?.trim() || undefined;
  }
}
