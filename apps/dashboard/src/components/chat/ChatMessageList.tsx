import React, { useEffect, useRef } from "react";
import type { ChatMessage as ChatMessageType } from "../../lib/chat-api";
import type { GitHubRepoListItem } from "../../lib/api";
import type { ModeSelectionStartConfig } from "./ModeSelectionCard";
import { ChatMessage } from "./ChatMessage";
import { BrailleSpinner } from "../BrailleSpinner";

interface ChatMessageListProps {
  messages: ChatMessageType[];
  streamingText: string;
  isStreaming: boolean;
  onConfirmPlan?: () => void;
  onConfigureRepo?: (config: {
    repoMode: string;
    githubOwner: string;
    githubRepo: string;
    baseBranch: string;
  }) => void;
  onStartExecution?: (config: ModeSelectionStartConfig) => void;
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

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  streamingText,
  isStreaming,
  onConfirmPlan,
  onConfigureRepo,
  onStartExecution,
  modeSelectionProps,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-2 py-4 space-y-1"
    >
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          onConfirmPlan={onConfirmPlan}
          onConfigureRepo={onConfigureRepo}
          onStartExecution={onStartExecution}
          modeSelectionProps={modeSelectionProps}
        />
      ))}

      {/* Streaming response */}
      {isStreaming && (
        <div className="py-2 px-3">
          <div className="flex items-start gap-2">
            <span className="text-term-tiger select-none shrink-0">[openTiger]</span>
            <div className="text-zinc-300 whitespace-pre-wrap break-words text-sm">
              {streamingText || (
                <span className="inline-flex items-center gap-2 text-zinc-500">
                  <BrailleSpinner variant="pendulum" width={6} className="[color:inherit]" />
                </span>
              )}
              <span className="inline-block w-1.5 h-4 bg-term-tiger animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {messages.length === 0 && !isStreaming && (
        <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
          <p>Start a conversation...</p>
        </div>
      )}
    </div>
  );
};
