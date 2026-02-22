import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chatApi,
  subscribeToChatStream,
  type ChatMessage,
} from "../lib/chat-api";
import { ChatMessageList } from "../components/chat/ChatMessageList";
import { ChatInput } from "../components/chat/ChatInput";
import { BrailleSpinner } from "../components/BrailleSpinner";

export const ChatPage: React.FC = () => {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    conversationId ?? null,
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const streamCleanupRef = useRef<(() => void) | null>(null);

  // Load conversation list
  const conversationsQuery = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () => chatApi.listConversations(),
    refetchInterval: 30000,
  });

  // Load active conversation messages
  const conversationQuery = useQuery({
    queryKey: ["chat", "conversation", activeConversationId],
    queryFn: () =>
      activeConversationId ? chatApi.getConversation(activeConversationId) : null,
    enabled: !!activeConversationId,
  });

  // Sync messages from query
  useEffect(() => {
    if (conversationQuery.data?.messages) {
      setChatMessages(conversationQuery.data.messages);
    }
  }, [conversationQuery.data]);

  // Sync URL param
  useEffect(() => {
    if (conversationId && conversationId !== activeConversationId) {
      setActiveConversationId(conversationId);
    }
  }, [conversationId, activeConversationId]);

  // Create new conversation
  const createMutation = useMutation({
    mutationFn: () => chatApi.createConversation(),
    onSuccess: (data) => {
      const id = data.conversation.id;
      setActiveConversationId(id);
      setChatMessages(data.messages);
      setStreamingText("");
      setIsStreaming(false);
      navigate(`/chat/${id}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
  });

  // Send message
  const sendMutation = useMutation({
    mutationFn: (content: string) => {
      if (!activeConversationId) throw new Error("No active conversation");
      return chatApi.sendMessage(activeConversationId, content);
    },
    onSuccess: (data) => {
      // Add user message to local state
      setChatMessages((prev) => [...prev, data.userMessage]);
      setStreamingText("");
      setIsStreaming(true);

      // Subscribe to streaming response
      if (activeConversationId) {
        const cleanup = subscribeToChatStream(
          activeConversationId,
          // onChunk
          (chunk) => {
            setStreamingText((prev) => prev + chunk);
          },
          // onDone
          (_content) => {
            setIsStreaming(false);
            setStreamingText("");
            // Refetch to get the saved assistant message
            queryClient.invalidateQueries({
              queryKey: ["chat", "conversation", activeConversationId],
            });
            queryClient.invalidateQueries({
              queryKey: ["chat", "conversations"],
            });
          },
          // onError
          (error) => {
            setIsStreaming(false);
            setStreamingText("");
            console.warn("[Chat] Stream error:", error);
            // Still refetch to see if a message was saved
            queryClient.invalidateQueries({
              queryKey: ["chat", "conversation", activeConversationId],
            });
          },
        );
        streamCleanupRef.current = cleanup;
      }
    },
  });

  // Confirm plan
  const confirmPlanMutation = useMutation({
    mutationFn: () => {
      if (!activeConversationId) throw new Error("No active conversation");
      return chatApi.confirmPlan(activeConversationId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversation", activeConversationId],
      });
    },
  });

  // Configure repo
  const configureRepoMutation = useMutation({
    mutationFn: (config: {
      repoMode: string;
      githubOwner: string;
      githubRepo: string;
      baseBranch: string;
    }) => {
      if (!activeConversationId) throw new Error("No active conversation");
      return chatApi.configureRepo(activeConversationId, config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversation", activeConversationId],
      });
    },
  });

  // Delete conversation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => chatApi.deleteConversation(id),
    onSuccess: (_, deletedId) => {
      if (deletedId === activeConversationId) {
        setActiveConversationId(null);
        setChatMessages([]);
        navigate("/chat", { replace: true });
      }
      queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
  });

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
      }
    };
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeConversationId) {
        // Auto-create conversation then send
        chatApi.createConversation().then((data) => {
          const id = data.conversation.id;
          setActiveConversationId(id);
          setChatMessages(data.messages);
          navigate(`/chat/${id}`, { replace: true });
          queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
          // Now send the message
          chatApi.sendMessage(id, content).then((sendData) => {
            setChatMessages((prev) => [...prev, sendData.userMessage]);
            setStreamingText("");
            setIsStreaming(true);

            const cleanup = subscribeToChatStream(
              id,
              (chunk) => setStreamingText((prev) => prev + chunk),
              () => {
                setIsStreaming(false);
                setStreamingText("");
                queryClient.invalidateQueries({ queryKey: ["chat", "conversation", id] });
                queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
              },
              () => {
                setIsStreaming(false);
                setStreamingText("");
                queryClient.invalidateQueries({ queryKey: ["chat", "conversation", id] });
              },
            );
            streamCleanupRef.current = cleanup;
          });
        });
      } else {
        sendMutation.mutate(content);
      }
    },
    [activeConversationId, sendMutation, navigate, queryClient],
  );

  const handleSelectConversation = (id: string) => {
    // Cleanup any active stream
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
    setIsStreaming(false);
    setStreamingText("");
    setActiveConversationId(id);
    navigate(`/chat/${id}`, { replace: true });
  };

  const conversations = conversationsQuery.data ?? [];

  return (
    <div className="flex h-full">
      {/* Sidebar - Conversation List */}
      <div className="w-56 border-r border-term-border flex flex-col shrink-0">
        <div className="px-3 py-3 border-b border-term-border">
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="w-full bg-term-tiger text-black px-3 py-1.5 text-xs font-bold uppercase hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {createMutation.isPending ? (
              <BrailleSpinner variant="pendulum" width={4} className="[color:inherit]" />
            ) : (
              "+ NEW CHAT"
            )}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center px-3 py-2 cursor-pointer border-b border-term-border/30 ${
                conv.id === activeConversationId
                  ? "bg-term-tiger/10 text-term-tiger"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
              onClick={() => handleSelectConversation(conv.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">
                  {conv.title || "New conversation"}
                </div>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {new Date(conv.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMutation.mutate(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs ml-2 shrink-0"
                title="Delete"
              >
                x
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="px-3 py-4 text-zinc-600 text-xs text-center">
              No conversations yet
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeConversationId ? (
          <>
            <ChatMessageList
              messages={chatMessages}
              streamingText={streamingText}
              isStreaming={isStreaming}
              onConfirmPlan={() => confirmPlanMutation.mutate()}
              onConfigureRepo={(config) => configureRepoMutation.mutate(config)}
            />
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming || sendMutation.isPending}
              placeholder={isStreaming ? "Waiting for response..." : "Type a message..."}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-600">
            <div className="text-center space-y-4">
              <div className="text-2xl font-bold text-term-tiger">openTiger</div>
              <p className="text-sm">Start a new conversation to begin.</p>
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                className="bg-term-tiger text-black px-6 py-2 text-sm font-bold uppercase hover:opacity-90 disabled:opacity-50"
              >
                {createMutation.isPending ? "CREATING..." : "NEW CONVERSATION"}
              </button>
              <div className="mt-6 text-xs text-zinc-700 max-w-md">
                <p>
                  Describe what you want to build, fix, or research.
                  Git/GitHub setup is only needed when your task requires it.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
