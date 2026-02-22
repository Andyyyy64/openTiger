import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chatApi,
  subscribeToChatStream,
  type ChatMessage,
} from "../lib/chat-api";
import { configApi, systemApi } from "../lib/api";
import { collectConfiguredExecutors } from "../lib/llm-executor";
import { ChatMessageList } from "../components/chat/ChatMessageList";
import { ChatInput } from "../components/chat/ChatInput";
import { NeofetchPanel } from "../components/NeofetchPanel";
import { BrailleSpinner } from "../components/BrailleSpinner";
import {
  getHostinfoFromStorage,
  setHostinfoToStorage,
  STATUS_LABELS,
  STATUS_COLORS,
  normalizeExecutionEnvironment,
  parseCount,
} from "../lib/status-helpers";

// --- Component ---

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
  const [cachedHostinfo, setCachedHostinfo] = useState("");
  const hasFetchedHostinfoRef = useRef(false);

  // --- Data queries ---

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
  });
  const configValues = config?.config ?? {};

  const { data: processes } = useQuery({
    queryKey: ["system", "processes"],
    queryFn: () => systemApi.processes(),
    refetchInterval: 5000,
  });

  const conversationsQuery = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () => chatApi.listConversations(),
    refetchInterval: 30000,
  });

  const conversationQuery = useQuery({
    queryKey: ["chat", "conversation", activeConversationId],
    queryFn: () =>
      activeConversationId ? chatApi.getConversation(activeConversationId) : null,
    enabled: !!activeConversationId,
  });

  // --- Auth checks ---

  const configuredExecutors = useMemo(() => {
    if (!config?.config) return new Set<"claude_code" | "codex" | "opencode">();
    return collectConfiguredExecutors(config.config);
  }, [config?.config]);

  const activeExecutorSignature = useMemo(
    () => Array.from(configuredExecutors).sort().join(","),
    [configuredExecutors],
  );

  const claudeAuthEnvironment = normalizeExecutionEnvironment(configValues.EXECUTION_ENVIRONMENT);

  const claudeAuthQuery = useQuery({
    queryKey: ["system", "claude-auth", activeExecutorSignature, claudeAuthEnvironment],
    queryFn: () => systemApi.claudeAuthStatus(claudeAuthEnvironment),
    enabled: configuredExecutors.has("claude_code"),
    retry: 0,
    refetchInterval: 120000,
  });

  const codexAuthQuery = useQuery({
    queryKey: ["system", "codex-auth", activeExecutorSignature, claudeAuthEnvironment],
    queryFn: () => systemApi.codexAuthStatus(claudeAuthEnvironment),
    enabled: configuredExecutors.has("codex"),
    retry: 0,
    refetchInterval: 120000,
  });

  const githubAuthMode = (configValues.GITHUB_AUTH_MODE ?? "gh").trim().toLowerCase();
  const githubAuthQuery = useQuery({
    queryKey: ["system", "github-auth", githubAuthMode],
    queryFn: () => systemApi.githubAuthStatus(),
    enabled: githubAuthMode === "gh",
    retry: 0,
    refetchInterval: 120000,
  });

  // --- Neofetch ---

  useEffect(() => {
    setCachedHostinfo(getHostinfoFromStorage());
  }, []);

  const hostinfoReloadMutation = useMutation({
    mutationFn: () => systemApi.neofetch(),
    onSuccess: (data) => {
      if (data?.available && data?.output) {
        setHostinfoToStorage(data.output);
        setCachedHostinfo(data.output);
      }
    },
  });

  useEffect(() => {
    const cached = getHostinfoFromStorage();
    if (!cached && !hasFetchedHostinfoRef.current) {
      hasFetchedHostinfoRef.current = true;
      hostinfoReloadMutation.mutate();
    }
  }, [hostinfoReloadMutation]);

  const hostinfoOutput =
    hostinfoReloadMutation.data?.available && hostinfoReloadMutation.data?.output
      ? hostinfoReloadMutation.data.output
      : cachedHostinfo;

  // --- Process status ---

  const workerCount = parseCount(configValues.WORKER_COUNT, 4).count;
  const testerCount = parseCount(configValues.TESTER_COUNT, 4).count;
  const judgeCount = parseCount(configValues.JUDGE_COUNT, 4).count;
  const plannerCount = parseCount(configValues.PLANNER_COUNT, 1).count;

  const runningWorkers =
    processes?.filter((p) => p.name.startsWith("worker-") && p.status === "running").length ?? 0;
  const runningTesters =
    processes?.filter((p) => p.name.startsWith("tester-") && p.status === "running").length ?? 0;
  const runningJudges =
    processes?.filter(
      (p) => (p.name === "judge" || p.name.startsWith("judge-")) && p.status === "running",
    ).length ?? 0;
  const runningPlanners =
    processes?.filter(
      (p) => (p.name === "planner" || p.name.startsWith("planner-")) && p.status === "running",
    ).length ?? 0;
  const dispatcherStatus =
    processes?.find((p) => p.name === "dispatcher")?.status ?? "idle";
  const cycleStatus =
    processes?.find((p) => p.name === "cycle-manager")?.status ?? "idle";

  // --- Sync messages from query ---

  useEffect(() => {
    if (conversationQuery.data?.messages) {
      setChatMessages(conversationQuery.data.messages);
    }
  }, [conversationQuery.data]);

  useEffect(() => {
    if (conversationId && conversationId !== activeConversationId) {
      setActiveConversationId(conversationId);
    }
  }, [conversationId, activeConversationId]);

  // --- Mutations ---

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

  const sendMutation = useMutation({
    mutationFn: (content: string) => {
      if (!activeConversationId) throw new Error("No active conversation");
      return chatApi.sendMessage(activeConversationId, content);
    },
    onSuccess: (data) => {
      setChatMessages((prev) => [...prev, data.userMessage]);
      setStreamingText("");
      setIsStreaming(true);
      if (activeConversationId) {
        const cleanup = subscribeToChatStream(
          activeConversationId,
          (chunk) => setStreamingText((prev) => prev + chunk),
          (_content) => {
            setIsStreaming(false);
            setStreamingText("");
            queryClient.invalidateQueries({
              queryKey: ["chat", "conversation", activeConversationId],
            });
            queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
          },
          () => {
            setIsStreaming(false);
            setStreamingText("");
            queryClient.invalidateQueries({
              queryKey: ["chat", "conversation", activeConversationId],
            });
          },
        );
        streamCleanupRef.current = cleanup;
      }
    },
  });

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

  const configureRepoMutation = useMutation({
    mutationFn: (repoConfig: {
      repoMode: string;
      githubOwner: string;
      githubRepo: string;
      baseBranch: string;
    }) => {
      if (!activeConversationId) throw new Error("No active conversation");
      return chatApi.configureRepo(activeConversationId, repoConfig);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversation", activeConversationId],
      });
    },
  });

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
        chatApi.createConversation().then((data) => {
          const id = data.conversation.id;
          setActiveConversationId(id);
          setChatMessages(data.messages);
          navigate(`/chat/${id}`, { replace: true });
          queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
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

  // --- Auth warnings ---

  const authWarnings: React.ReactNode[] = [];
  if (configuredExecutors.has("claude_code") && claudeAuthQuery.data && !claudeAuthQuery.data.authenticated) {
    authWarnings.push(
      <div key="claude" className="text-yellow-500">
        &gt; WARN: Claude Code not ready. {claudeAuthQuery.data.message ?? "Run `claude` and complete `/login`."}
      </div>,
    );
  }
  if (configuredExecutors.has("codex") && codexAuthQuery.data && !codexAuthQuery.data.authenticated) {
    authWarnings.push(
      <div key="codex" className="text-yellow-500">
        &gt; WARN: Codex not ready. {codexAuthQuery.data.message ?? "Run `codex login` or set OPENAI_API_KEY."}
      </div>,
    );
  }
  if (githubAuthMode === "gh" && githubAuthQuery.data && !githubAuthQuery.data.authenticated) {
    authWarnings.push(
      <div key="github" className="text-red-500">
        &gt; WARN: GitHub CLI not ready. {githubAuthQuery.data.message ?? "Run `gh auth login`."}
      </div>,
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Auth warnings bar */}
      {authWarnings.length > 0 && (
        <div className="border-b border-term-border bg-yellow-900/5 px-4 py-2 text-xs font-mono space-y-1 shrink-0">
          {authWarnings}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - Conversation List */}
        <div className="w-52 border-r border-term-border flex flex-col shrink-0">
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
                  <div className="text-xs truncate">{conv.title || "New conversation"}</div>
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
              <div className="px-3 py-4 text-zinc-600 text-xs text-center">No conversations yet</div>
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
                onConfigureRepo={(c) => configureRepoMutation.mutate(c)}
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
                  <p>Describe what you want to build, fix, or research.</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar - Status Monitor + Neofetch */}
        <div className="w-72 border-l border-term-border flex flex-col shrink-0 overflow-y-auto">
          {/* Status Monitor */}
          <div className="border-b border-term-border">
            <div className="bg-term-border/10 px-3 py-1.5 border-b border-term-border">
              <h2 className="text-[11px] font-bold uppercase tracking-wider">Status_Monitor</h2>
            </div>
            <div className="p-3 font-mono text-xs space-y-2">
              <div className="grid grid-cols-2 gap-y-1">
                <span className="text-zinc-500">Dispatcher</span>
                <span className={STATUS_COLORS[dispatcherStatus]}>{STATUS_LABELS[dispatcherStatus]}</span>

                <span className="text-zinc-500">Planner</span>
                <span className={STATUS_COLORS[runningPlanners > 0 ? "running" : "idle"]}>
                  {runningPlanners > 0 ? "RUNNING" : "IDLE"} ({runningPlanners}/{plannerCount})
                </span>

                <span className="text-zinc-500">Judge</span>
                <span className={STATUS_COLORS[runningJudges > 0 ? "running" : "idle"]}>
                  {runningJudges > 0 ? "RUNNING" : "IDLE"} ({runningJudges}/{judgeCount})
                </span>

                <span className="text-zinc-500">CycleMgr</span>
                <span className={STATUS_COLORS[cycleStatus]}>{STATUS_LABELS[cycleStatus]}</span>
              </div>

              <div className="border-t border-term-border pt-2 space-y-1.5">
                <div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-zinc-500">Workers</span>
                    <span>{runningWorkers}/{workerCount}</span>
                  </div>
                  <div className="w-full bg-zinc-900 h-1 mt-0.5">
                    <div
                      className="h-full bg-term-tiger"
                      style={{ width: `${workerCount > 0 ? (runningWorkers / workerCount) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-zinc-500">Testers</span>
                    <span>{runningTesters}/{testerCount}</span>
                  </div>
                  <div className="w-full bg-zinc-900 h-1 mt-0.5">
                    <div
                      className="h-full bg-term-tiger"
                      style={{ width: `${testerCount > 0 ? (runningTesters / testerCount) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Neofetch */}
          <div className="flex-1">
            <NeofetchPanel
              output={hostinfoOutput}
              onReload={() => hostinfoReloadMutation.mutate()}
              isReloading={hostinfoReloadMutation.isPending}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
