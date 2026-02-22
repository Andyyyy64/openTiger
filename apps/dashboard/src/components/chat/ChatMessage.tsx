import React from "react";
import type { ChatMessage as ChatMessageType } from "../../lib/chat-api";
import { PlanProposalCard } from "./PlanProposalCard";
import { RepoPromptCard } from "./RepoPromptCard";
import { ExecutionStatusCard } from "./ExecutionStatusCard";

interface ChatMessageProps {
  message: ChatMessageType;
  onConfirmPlan?: () => void;
  onConfigureRepo?: (config: {
    repoMode: string;
    githubOwner: string;
    githubRepo: string;
    baseBranch: string;
  }) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  onConfirmPlan,
  onConfigureRepo,
}) => {
  // Special message types
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
