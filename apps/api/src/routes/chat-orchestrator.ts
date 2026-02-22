/**
 * Chat orchestrator — builds system prompts and manages conversation phase transitions.
 */

import type { MessageRecord, ConfigRecord } from "@openTiger/db/schema";

export type ConversationPhase =
  | "greeting"
  | "requirement_gathering"
  | "plan_proposal"
  | "execution"
  | "monitoring";

/** Marker the LLM appends when its plan is complete. */
export const PLAN_READY_MARKER = "---PLAN_READY---";

export function resolvePhase(
  messages: Pick<MessageRecord, "role" | "content" | "messageType">[],
  metadata: Record<string, unknown> | null,
): ConversationPhase {
  // Honour metadata.phase for terminal states set via user actions.
  const metaPhase = metadata?.phase;
  if (metaPhase === "execution" || metaPhase === "monitoring") {
    return metaPhase;
  }

  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return "greeting";

  // Check for execution_status messages
  const hasExecution = messages.some((m) => m.messageType === "execution_status");
  if (hasExecution) return "monitoring";

  // Check for mode_selection messages (plan was ready, waiting for user to pick mode)
  const hasModeSelection = messages.some((m) => m.messageType === "mode_selection");
  if (hasModeSelection) return "plan_proposal";

  // Check if any assistant message contains the PLAN_READY marker
  const hasPlanReady = messages.some(
    (m) => m.role === "assistant" && m.content.includes(PLAN_READY_MARKER),
  );
  if (hasPlanReady) return "plan_proposal";

  // Check for legacy plan_proposal messages
  const hasPlan = messages.some((m) => m.messageType === "plan_proposal");
  if (hasPlan) return "plan_proposal";

  return "requirement_gathering";
}

const SYSTEM_PROMPTS: Record<ConversationPhase, string> = {
  greeting: `You are openTiger, an autonomous coding orchestration system. You help users plan and execute software development tasks.

Greet the user warmly and ask what they'd like to work on. Keep it concise and terminal-styled.
You can help with:
- Planning and executing code tasks
- Research tasks
- Bug fixes and feature development

Ask what they need help with. Do NOT ask about Git/GitHub setup — that is handled separately by the UI.`,

  requirement_gathering: `You are openTiger's autonomous planning engine. The user is describing what they want to build or fix.

CRITICAL RULES:
1. Make technical decisions yourself. If something is ambiguous (language version, build tool, architecture pattern, library choice), pick the best option and state your choice confidently. Do NOT ask the user to choose between technical alternatives.
2. Only ask a question if you literally cannot proceed without user input (e.g. the domain is completely unclear, or there are mutually exclusive business requirements). Maximum 1 question per response.
3. Produce a concrete task plan within 1-2 turns. Do not drag the conversation out.
4. NEVER ask "shall I proceed?", "does this look good?", "would you like me to start?", or any confirmation question. The UI handles execution confirmation separately.

When you have enough information (which may be immediately from the first message), output a plan in this format:
- Clear task titles with brief descriptions
- Estimated risk levels (low/medium/high)
- Suggested execution order

When your plan is complete, append this exact marker on its own line at the very end:
---PLAN_READY---

Do NOT ask for confirmation after the plan. The marker triggers the next step automatically.
Use markdown for structure. Keep responses concise.`,

  plan_proposal: `You are openTiger's planning assistant. A plan has been proposed and the user may want adjustments.

If the user asks for changes, revise the plan and include the ---PLAN_READY--- marker again at the end.
Keep responses concise. Do not ask for confirmation — the UI handles that.`,

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
