import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chatApi,
  subscribeToChatStream,
  type ChatMessage,
} from "../lib/chat-api";
import { agentsApi, configApi, systemApi } from "../lib/api";
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

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => agentsApi.list(),
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

  // --- GitHub repos for ModeSelectionCard ---

  const requiresGithubToken = githubAuthMode === "token";
  const hasGithubAuth = requiresGithubToken ? Boolean(configValues.GITHUB_TOKEN?.trim()) : true;
  const repoListOwnerFilter =
    githubAuthMode === "gh" ? undefined : configValues.GITHUB_OWNER?.trim() || undefined;

  const githubReposQuery = useQuery({
    queryKey: ["system", "github-repos", repoListOwnerFilter ?? ""],
    queryFn: () => systemApi.listGithubRepos({ owner: repoListOwnerFilter }),
    enabled: hasGithubAuth,
  });
  const githubRepos = useMemo(() => githubReposQuery.data?.repos ?? [], [githubReposQuery.data]);

  const currentRepo = useMemo(() => {
    const owner = configValues.GITHUB_OWNER?.trim();
    const repo = configValues.GITHUB_REPO?.trim();
    if (!owner || !repo) return null;
    return {
      owner,
      repo,
      url: configValues.REPO_URL?.trim() || undefined,
      branch: configValues.BASE_BRANCH?.trim() || "main",
    };
  }, [configValues.GITHUB_OWNER, configValues.GITHUB_REPO, configValues.REPO_URL, configValues.BASE_BRANCH]);

  const createRepoMutation = useMutation({
    mutationFn: async ({ owner, repo }: { owner: string; repo: string }) => {
      const created = await systemApi.createGithubRepo({ owner, repo, private: true });
      // Also update global config
      await configApi.update({
        REPO_MODE: "git",
        GITHUB_OWNER: created.owner,
        GITHUB_REPO: created.name,
        REPO_URL: created.url,
        BASE_BRANCH: created.defaultBranch,
      });
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["system", "github-repos"] });
    },
  });

  const handleCreateRepo = useCallback(
    async (owner: string, repo: string) => {
      await createRepoMutation.mutateAsync({ owner, repo });
    },
    [createRepoMutation],
  );


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
    // Don't overwrite optimistically-added messages while streaming
    if (isStreaming) return;
    if (conversationQuery.data?.messages) {
      setChatMessages(conversationQuery.data.messages);
    }
  }, [conversationQuery.data, isStreaming]);

  useEffect(() => {
    if (conversationId && conversationId !== activeConversationId) {
      setActiveConversationId(conversationId);
    }
  }, [conversationId, activeConversationId]);

  // Auto-select the most recent executing conversation when landing on /chat with no id
  useEffect(() => {
    if (conversationId || activeConversationId) return;
    const conversations = conversationsQuery.data;
    if (!conversations || conversations.length === 0) return;

    const executing = conversations
      .filter((c) => {
        const phase = (c.metadata as Record<string, unknown> | null)?.phase;
        return phase === "execution" || phase === "monitoring";
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (executing.length > 0 && executing[0]) {
      const id = executing[0].id;
      setActiveConversationId(id);
      navigate(`/chat/${id}`, { replace: true });
    }
  }, [conversationId, activeConversationId, conversationsQuery.data, navigate]);

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

  const startExecutionMutation = useMutation({
    mutationFn: async (execConfig: {
      mode: "local" | "git";
      githubOwner?: string;
      githubRepo?: string;
      baseBranch?: string;
    }) => {
      if (!activeConversationId) throw new Error("No active conversation");

      // 1. Update conversation metadata (existing chat API)
      await chatApi.startExecution(activeConversationId, execConfig);

      // 2. Extract plan content from conversation messages for requirement sync
      const planContent = chatMessages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n\n");

      // 3. Sync requirement content
      if (planContent.trim().length > 0) {
        await systemApi.syncRequirement({ content: planContent });
      }

      // 4. Run preflight to get process recommendations
      const preflight = await systemApi.preflight({
        content: planContent,
        autoCreateIssueTasks: true,
      });
      const recommendations = preflight.recommendations;

      // 5. Read config counts
      const settings = config?.config ?? {};
      const executionEnvironment = normalizeExecutionEnvironment(settings.EXECUTION_ENVIRONMENT);
      const sandboxExecution = executionEnvironment === "sandbox";
      const workerCount = parseCount(settings.WORKER_COUNT, 4, "Worker");
      const judgeCount = parseCount(settings.JUDGE_COUNT, 4, "Judge");
      const plannerCount = parseCount(settings.PLANNER_COUNT, 1, "Planner", 4);

      const started: string[] = [];
      const errors: string[] = [];

      const startProcess = async (
        name: string,
        payload?: { content?: string },
      ) => {
        try {
          await systemApi.startProcess(name, payload);
          started.push(name);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          errors.push(`${name}: ${message}`);
        }
      };

      // 6. Start processes based on recommendations
      const plannerStartCount = Math.min(
        plannerCount.count,
        recommendations.plannerCount ?? (recommendations.startPlanner ? 1 : 0),
      );
      for (let i = 1; i <= plannerStartCount; i += 1) {
        const plannerName = i === 1 ? "planner" : `planner-${i}`;
        await startProcess(plannerName, { content: planContent });
      }

      if (recommendations.startDispatcher) {
        await startProcess("dispatcher");
      }

      const judgeStartCount = Math.min(
        judgeCount.count,
        recommendations.judgeCount ?? (recommendations.startJudge ? 1 : 0),
      );
      for (let i = 1; i <= judgeStartCount; i += 1) {
        const judgeName = i === 1 ? "judge" : `judge-${i}`;
        await startProcess(judgeName);
      }

      if (recommendations.startCycleManager) {
        await startProcess("cycle-manager");
      }

      const workerStartCount = sandboxExecution
        ? 0
        : Math.min(workerCount.count, recommendations.workerCount);
      for (let i = 1; i <= workerStartCount; i += 1) await startProcess(`worker-${i}`);

      return { started, errors };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversation", activeConversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["system", "processes"] });
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const conversationPhase = (conversationQuery.data?.conversation?.metadata as Record<string, unknown> | null)?.phase;
  const alreadyExecuting = conversationPhase === "execution" || conversationPhase === "monitoring";

  const executionStatus: "idle" | "pending" | "success" | "error" = alreadyExecuting
    ? "success"
    : startExecutionMutation.isSuccess
      ? "success"
      : startExecutionMutation.isError
        ? "error"
        : startExecutionMutation.isPending
          ? "pending"
          : "idle";

  const modeSelectionProps = useMemo(
    () => ({
      currentRepo,
      githubRepos,
      isLoadingRepos: githubReposQuery.isLoading,
      onRefreshRepos: () => githubReposQuery.refetch(),
      onCreateRepo: handleCreateRepo,
      isCreatingRepo: createRepoMutation.isPending,
      executionStatus,
    }),
    [currentRepo, githubRepos, githubReposQuery.isLoading, githubReposQuery, handleCreateRepo, createRepoMutation.isPending, executionStatus],
  );

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

  const [isCreatingSend, setIsCreatingSend] = useState(false);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeConversationId) {
        if (isCreatingSend) return;
        setIsCreatingSend(true);
        chatApi.createConversation().then((data) => {
          const id = data.conversation.id;
          setActiveConversationId(id);
          setChatMessages(data.messages);
          navigate(`/chat/${id}`, { replace: true });
          queryClient.invalidateQueries({ queryKey: ["chat", "conversations"] });
          return chatApi.sendMessage(id, content).then((sendData) => {
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
        }).catch((err) => {
          console.warn("[Chat] Failed to create conversation and send:", err);
        }).finally(() => {
          setIsCreatingSend(false);
        });
      } else {
        sendMutation.mutate(content);
      }
    },
    [activeConversationId, isCreatingSend, sendMutation, navigate, queryClient],
  );

  const handleSelectConversation = (id: string) => {
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
    setIsStreaming(false);
    setStreamingText("");
    setChatMessages([]);
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
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {activeConversationId ? (
            <>
              <ChatMessageList
                messages={chatMessages}
                streamingText={streamingText}
                isStreaming={isStreaming}
                onConfirmPlan={() => confirmPlanMutation.mutate()}
                onConfigureRepo={(c) => configureRepoMutation.mutate(c)}
                onStartExecution={(c) => startExecutionMutation.mutate(c)}
                modeSelectionProps={modeSelectionProps}
                processes={processes}
                agents={agents}
                onViewDetails={() => navigate("/agents")}
              />
              <ChatInput
                onSend={handleSend}
                disabled={isStreaming || sendMutation.isPending || isCreatingSend}
                placeholder={isStreaming ? "Waiting for response..." : "Type a message..."}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-600">
              <div className="text-center space-y-4">
                <div className="text-2xl font-bold text-term-tiger">openTiger</div>
                <p className="text-sm">Start a new conversation to begin.</p>
                <div className="text-xs text-zinc-700 max-w-md">
                  <p>Describe what you want to build, fix, or research.</p>
                </div>
                <div className="flex items-center justify-center gap-4">
                  <button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending}
                    className="bg-term-tiger text-black px-6 py-2 text-sm font-bold uppercase hover:opacity-90 disabled:opacity-50"
                  >
                    {createMutation.isPending ? "CREATING..." : "NEW CONVERSATION"}
                  </button>
                  <button
                    onClick={() => navigate("/start")}
                    className="text-xs text-zinc-600 hover:text-term-tiger uppercase tracking-wide transition-colors cursor-pointer"
                  >
                    &gt; start without chat
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar - Status Monitor + Neofetch */}
        <div className="w-80 border-l border-term-border flex flex-col shrink-0 min-h-0 overflow-y-auto">
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
