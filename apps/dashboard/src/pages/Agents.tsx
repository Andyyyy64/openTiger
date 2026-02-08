import React from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, tasksApi } from "../lib/api";
import { Link } from "react-router-dom";

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

  // Detect state where dispatch is not possible due to incomplete dependencies
  const queuedTasks = tasks?.filter((t) => t.status === "queued") ?? [];
  const doneTaskIds = new Set((tasks ?? []).filter((t) => t.status === "done").map((t) => t.id));
  const queuedBlockedByDeps = queuedTasks.filter((task) => {
    const deps = task.dependencies ?? [];
    return deps.length > 0 && deps.some((depId) => !doneTaskIds.has(depId));
  });
  const idleWorkers = agents?.filter((a) => a.role === "worker" && a.status === "idle") ?? [];
  const blockedByDepsWithIdleWorkers =
    queuedTasks.length > 0 &&
    queuedBlockedByDeps.length === queuedTasks.length &&
    idleWorkers.length > 0;

  const sortedAgents = React.useMemo(() => {
    if (!agents) return [];
    return [...agents].sort((a, b) => {
      // 1. Busy agents first
      if (a.status === "busy" && b.status !== "busy") return -1;
      if (a.status !== "busy" && b.status === "busy") return 1;

      // 2. Sort by role
      if (a.role !== b.role) return a.role.localeCompare(b.role);

      // 3. Sort by ID
      return a.id.localeCompare(b.id);
    });
  }, [agents]);

  return (
    <div className="p-6 text-term-fg">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Connected_Nodes (Agents)
        </h1>
        <span className="text-xs text-zinc-500">{agents?.length ?? 0} NODES ONLINE</span>
      </div>

      {blockedByDepsWithIdleWorkers && (
        <div className="mb-8 border border-yellow-600 p-4 text-sm text-yellow-500 font-bold bg-yellow-900/10">
          [WARNING] 依存関係が未完了のため、待機中タスクがディスパッチできません。
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
            {sortedAgents.map((agent) => (
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
                    className={`text-xs uppercase px-1 ${agent.status === "busy" ? "bg-term-tiger text-black font-bold animate-pulse" : "text-zinc-500"}`}
                  >
                    {agent.status === "busy" ? "PROCESSING" : "IDLE"}
                  </span>
                </div>

                <div className="col-span-2 text-xs text-zinc-400">
                  {agent.metadata?.provider && <span>{agent.metadata.provider}</span>}
                  {agent.metadata?.model && (
                    <span className="text-zinc-600 block">{agent.metadata.model}</span>
                  )}
                </div>

                <div className="col-span-3 text-xs">
                  {agent.status === "busy" ? (
                    <div className="w-full">
                      <div className="flex justify-between mb-1">
                        <span className="text-term-tiger">EXEC_TASK</span>
                        <span className="text-zinc-500">{agent.currentTaskId?.slice(0, 8)}</span>
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
