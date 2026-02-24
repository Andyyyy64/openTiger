import React from "react";
import type { ChatMessage as ChatMessageType } from "../../lib/chat-api";
import type { GitHubRepoListItem } from "../../lib/api";
import { PlanProposalCard } from "./PlanProposalCard";
import { RepoPromptCard } from "./RepoPromptCard";
import { ExecutionStatusCard } from "./ExecutionStatusCard";
import { ModeSelectionCard, type ModeSelectionStartConfig } from "./ModeSelectionCard";

interface ChatMessageProps {
  message: ChatMessageType;
  onConfirmPlan?: () => void;
  onConfigureRepo?: (config: {
    repoMode: string;
    githubOwner: string;
    githubRepo: string;
    baseBranch: string;
  }) => void;
  onStartExecution?: (config: ModeSelectionStartConfig) => void;
  /** Props forwarded to ModeSelectionCard */
  modeSelectionProps?: {
    currentRepo?: { owner: string; repo: string; url?: string; branch?: string } | null;
    githubRepos?: GitHubRepoListItem[];
    isLoadingRepos?: boolean;
    onRefreshRepos?: () => void;
    onCreateRepo?: (owner: string, repo: string) => Promise<void>;
    isCreatingRepo?: boolean;
    executionStatus?: "idle" | "pending" | "success" | "error";
  };
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  onConfirmPlan,
  onConfigureRepo,
  onStartExecution,
  modeSelectionProps,
}) => {
  // Special message types
  if (message.messageType === "mode_selection") {
    return (
      <ModeSelectionCard
        onStartExecution={onStartExecution}
        currentRepo={modeSelectionProps?.currentRepo}
        githubRepos={modeSelectionProps?.githubRepos}
        isLoadingRepos={modeSelectionProps?.isLoadingRepos}
        onRefreshRepos={modeSelectionProps?.onRefreshRepos}
        onCreateRepo={modeSelectionProps?.onCreateRepo}
        isCreatingRepo={modeSelectionProps?.isCreatingRepo}
        executionStatus={modeSelectionProps?.executionStatus}
      />
    );
  }
  if (message.messageType === "plan_proposal") {
    return <PlanProposalCard content={message.content} onConfirm={onConfirmPlan} />;
  }
  if (message.messageType === "repo_prompt") {
    return <RepoPromptCard onConfigure={onConfigureRepo} />;
  }
  if (message.messageType === "execution_status") {
    return <ExecutionStatusCard content={message.content} metadata={message.metadata} />;
  }

  // Role-based rendering
  if (message.role === "user") {
    return (
      <div className="py-2 px-3">
        <div className="flex items-start gap-2">
          <span className="text-zinc-500 select-none shrink-0">&gt;</span>
          <div className="text-term-fg whitespace-pre-wrap break-words text-sm">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="py-2 px-3">
        <div className="flex items-start gap-2">
          <span className="text-term-tiger select-none shrink-0">[openTiger]</span>
          <div className="text-zinc-300 whitespace-pre-wrap break-words text-sm">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // System messages
  return (
    <div className="py-1 px-3">
      <div className="flex items-start gap-2">
        <span className="text-zinc-600 select-none shrink-0">//</span>
        <div className="text-zinc-500 whitespace-pre-wrap break-words text-xs">
          {message.content}
        </div>
      </div>
    </div>
  );
};
