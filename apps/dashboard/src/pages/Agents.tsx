import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  configApi,
  tasksApi,
  systemApi,
  resolveProcessNameFromAgentId,
} from "../lib/api";
import { Link } from "react-router-dom";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  CODEX_DEFAULT_MODEL,
  isClaudeExecutor,
  isCodexExecutor,
  normalizeClaudeModel,
  normalizeCodexModel,
} from "../lib/llm-executor";

export const AgentsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const {
    data: agents,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["agents"],
    queryFn: () => agentsApi.list(),
  });
  const { data: tasks } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => tasksApi.list(),
  });
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
  });
  const { data: processes } = useQuery({
    queryKey: ["system", "processes"],
    queryFn: () => systemApi.processes(),
    refetchInterval: 10000,
  });

  const llmExecutor = config?.config.LLM_EXECUTOR;
  const useClaudeLabels = isClaudeExecutor(llmExecutor);
  const useCodexLabels = isCodexExecutor(llmExecutor);
  const configuredClaudeModel =
    normalizeClaudeModel(config?.config.CLAUDE_CODE_MODEL) ?? CLAUDE_CODE_DEFAULT_MODEL;
  const configuredCodexModel =
    normalizeCodexModel(config?.config.CODEX_MODEL) ?? CODEX_DEFAULT_MODEL;
  const onlineAgents = (agents ?? []).filter((agent) => agent.status !== "offline");

  // Detect state where dispatch is not possible due to incomplete dependencies
  const queuedTasks = tasks?.filter((t) => t.status === "queued") ?? [];
  const resolvedDependencyStatuses = new Set(["done", "cancelled", "failed"]);
  const resolvedDependencyTaskIds = new Set(
    (tasks ?? []).filter((t) => resolvedDependencyStatuses.has(t.status)).map((t) => t.id),
  );
  const queuedBlockedByDeps = queuedTasks.filter((task) => {
    const deps = task.dependencies ?? [];
    return deps.some((depId) => !resolvedDependencyTaskIds.has(depId));
  });
  const idleWorkers = agents?.filter((a) => a.role === "worker" && a.status === "idle") ?? [];
  const blockedByDepsWithIdleWorkers =
    queuedTasks.length > 0 &&
    queuedBlockedByDeps.length === queuedTasks.length &&
    idleWorkers.length > 0;

  // Sort by "last busy" time: PROCESSING first, then by lastHeartbeat descending (most recently active at top)
  const sortedAgents = React.useMemo(() => {
    if (!agents) return [];
    return [...agents].sort((a, b) => {
      const statusRank: Record<string, number> = {
        busy: 0,
        idle: 1,
        offline: 2,
      };
      const rankA = statusRank[a.status] ?? 99;
      const rankB = statusRank[b.status] ?? 99;
      if (rankA !== rankB) {
        return rankA - rankB;
      }

      // Same status: sort by lastHeartbeat descending (most recently active first)
      const tsA = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const tsB = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      if (tsA !== tsB) return tsB - tsA;

      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return a.id.localeCompare(b.id);
    });
  }, [agents]);

  const taskTitleById = React.useMemo(() => {
    const titleMap = new Map<string, string>();
    for (const task of tasks ?? []) {
      titleMap.set(task.id, task.title);
    }
    return titleMap;
  }, [tasks]);
  const processStatusByName = React.useMemo(() => {
    const statusMap = new Map<string, string>();
    for (const process of processes ?? []) {
      statusMap.set(process.name, process.status);
    }
    return statusMap;
  }, [processes]);

  const stopMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.stop(agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["system", "processes"] });
    },
  });
  const startMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.start(agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["system", "processes"] });
    },
  });

  const handleStop = (agentId: string) => {
    if (stopMutation.isPending || startMutation.isPending) {
      return;
    }
    if (!window.confirm(`Stop ${agentId}? Running task will be cancelled.`)) {
      return;
    }
    stopMutation.mutate(agentId);
  };
  const handleStart = (agentId: string) => {
    if (startMutation.isPending || stopMutation.isPending) {
      return;
    }
    startMutation.mutate(agentId);
  };

  return (
    <div className="p-6 text-term-fg">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Connected_Nodes (Agents)
        </h1>
        <span className="text-xs text-zinc-500">{onlineAgents.length} NODES ONLINE</span>
      </div>

      {blockedByDepsWithIdleWorkers && (
        <div className="mb-8 border border-yellow-600 p-4 text-sm text-yellow-500 font-bold bg-yellow-900/10">
          [WARNING] Dependencies incomplete; queued tasks cannot be dispatched.
          <br />
          &gt; QUEUED: {queuedTasks.length} | BLOCKED: {queuedBlockedByDeps.length} | IDLE_WORKERS:{" "}
          {idleWorkers.length}
        </div>
      )}

      <div className="border border-term-border">
        <div className="grid grid-cols-12 gap-4 px-4 py-2 border-b border-term-border bg-term-border/10 text-xs font-bold text-zinc-500 uppercase">
          <div className="col-span-3">Node ID / Type</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Provider</div>
          <div className="col-span-2">Current Process</div>
          <div className="col-span-1 text-right">Last Heartbeat</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-zinc-500 font-mono animate-pulse">
            &gt; Scanning network...
          </div>
        ) : error ? (
          <div className="py-12 text-center text-red-500 font-mono">&gt; CONNECTION ERROR</div>
        ) : agents?.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 font-mono">&gt; No nodes detected</div>
        ) : (
          <div className="divide-y divide-term-border font-mono text-sm">
            {sortedAgents.map((agent) => {
              const currentTaskTitle = agent.currentTaskId
                ? taskTitleById.get(agent.currentTaskId)
                : undefined;

              const processName = resolveProcessNameFromAgentId(agent.id);
              const processStatus = processName ? processStatusByName.get(processName) : undefined;
              const canControl = Boolean(processName);
              const canStop = canControl && processStatus === "running";
              const canStart = canControl && processStatus !== "running";
              const isMutating = stopMutation.isPending || startMutation.isPending;
              return (
                <div
                  key={agent.id}
                  className="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-term-tiger/5 transition-colors group items-center"
                >
                  <div className="col-span-3 overflow-hidden">
                    <Link
                      to={`/agents/${agent.id}`}
                      className="font-bold text-term-fg group-hover:text-term-tiger truncate block hover:underline"
                    >
                      {agent.id}
                    </Link>
                    <div className="text-xs text-zinc-500 uppercase flex gap-2 mt-1">
                      <span>[{agent.role}]</span>
                    </div>
                  </div>

                  <div className="col-span-2">
                    <span
                      className={`text-xs uppercase px-1 ${
                        agent.status === "busy"
                          ? "bg-term-tiger text-black font-bold animate-pulse"
                          : agent.status === "offline"
                            ? "text-red-500"
                            : "text-zinc-500"
                      }`}
                    >
                      {agent.status === "busy"
                        ? "PROCESSING"
                        : agent.status === "offline"
                          ? "OFFLINE"
                          : "IDLE"}
                    </span>
                  </div>

                  <div className="col-span-2 text-xs text-zinc-400">
                    <span>
                      {useClaudeLabels
                        ? "claude_code"
                        : useCodexLabels
                          ? "codex"
                          : (agent.metadata?.provider ?? "--")}
                    </span>
                    <span className="text-zinc-600 block">
                      {useClaudeLabels
                        ? (normalizeClaudeModel(agent.metadata?.model) ?? configuredClaudeModel)
                        : useCodexLabels
                          ? (normalizeCodexModel(agent.metadata?.model) ?? configuredCodexModel)
                        : (agent.metadata?.model ?? "--")}
                    </span>
                  </div>

                  <div className="col-span-2 text-xs">
                    {agent.status === "busy" ? (
                      <div className="w-full">
                        <div className="flex justify-between mb-1">
                          <span className="text-term-tiger">EXEC_TASK</span>
                          <span className="text-zinc-500">
                            {agent.currentTaskId?.slice(0, 8) ?? "--"}
                          </span>
                        </div>
                        <div className="text-zinc-300 truncate mb-1">
                          {currentTaskTitle ?? "Task title unavailable"}
                        </div>
                        <div className="w-full bg-zinc-800 h-2">
                          <div className="h-full bg-term-tiger w-[60%] repeating-linear-gradient-animation"></div>
                        </div>
                      </div>
                    ) : (
                      <span className="text-zinc-600">--</span>
                    )}
                  </div>

                  <div className="col-span-1 text-right text-xs text-zinc-600">
                    {agent.lastHeartbeat
                      ? new Date(agent.lastHeartbeat).toLocaleTimeString()
                      : "--:--:--"}
                  </div>
                  <div className="col-span-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => handleStart(agent.id)}
                      disabled={!canStart || isMutating}
                      className={`px-2 py-1 text-[10px] border font-bold ${
                        canStart && !isMutating
                          ? "border-term-tiger text-term-tiger hover:bg-term-tiger/10"
                          : "border-zinc-700 text-zinc-600 cursor-not-allowed"
                      }`}
                    >
                      START
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStop(agent.id)}
                      disabled={!canStop || isMutating}
                      className={`px-2 py-1 text-[10px] border font-bold ${
                        canStop && !isMutating
                          ? "border-red-500 text-red-400 hover:bg-red-500/10"
                          : "border-zinc-700 text-zinc-600 cursor-not-allowed"
                      }`}
                    >
                      STOP
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {(startMutation.isError || stopMutation.isError) && (
        <div className="mt-4 text-xs text-red-400 font-mono">
          {startMutation.isError
            ? `START_FAILED: ${startMutation.error instanceof Error ? startMutation.error.message : "error"}`
            : `STOP_FAILED: ${stopMutation.error instanceof Error ? stopMutation.error.message : "error"}`}
        </div>
      )}
    </div>
  );
};
