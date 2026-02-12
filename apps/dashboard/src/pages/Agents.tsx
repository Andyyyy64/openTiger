import React from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, configApi, tasksApi } from "../lib/api";
import { Link } from "react-router-dom";

const CLAUDE_CODE_DEFAULT_MODEL = "claude-opus-4-6";

function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function normalizeClaudeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("anthropic/")) {
    return trimmed.slice("anthropic/".length);
  }
  if (trimmed.startsWith("claude")) {
    return trimmed;
  }
  return undefined;
}

export const AgentsPage: React.FC = () => {
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

  const llmExecutor = config?.config.LLM_EXECUTOR;
  const useClaudeLabels = isClaudeExecutor(llmExecutor);
  const configuredClaudeModel =
    normalizeClaudeModel(config?.config.CLAUDE_CODE_MODEL) ?? CLAUDE_CODE_DEFAULT_MODEL;
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

      // 2. Sort by role
      if (a.role !== b.role) return a.role.localeCompare(b.role);

      // 3. Sort by ID
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
          <div className="col-span-3">Current Process</div>
          <div className="col-span-2 text-right">Last Heartbeat</div>
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

              return (
                <Link
                  key={agent.id}
                  to={`/agents/${agent.id}`}
                  className="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-term-tiger/5 transition-colors group items-center"
                >
                  <div className="col-span-3 overflow-hidden">
                    <div className="font-bold text-term-fg group-hover:text-term-tiger truncate">
                      {agent.id}
                    </div>
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
                      {useClaudeLabels ? "claude_code" : (agent.metadata?.provider ?? "--")}
                    </span>
                    <span className="text-zinc-600 block">
                      {useClaudeLabels
                        ? (normalizeClaudeModel(agent.metadata?.model) ?? configuredClaudeModel)
                        : (agent.metadata?.model ?? "--")}
                    </span>
                  </div>

                  <div className="col-span-3 text-xs">
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

                  <div className="col-span-2 text-right text-xs text-zinc-600">
                    {agent.lastHeartbeat
                      ? new Date(agent.lastHeartbeat).toLocaleTimeString()
                      : "--:--:--"}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
