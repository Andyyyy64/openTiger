import React from "react";
import type { SystemProcess } from "../../lib/api";
import type { Agent } from "@openTiger/core";
import { BrailleSpinner } from "../BrailleSpinner";

interface ExecutionProgressCardProps {
  processes: SystemProcess[];
  agents?: Agent[];
  onViewDetails?: () => void;
}

type GroupStatus = "busy" | "idle" | "completed" | "failed" | "offline";

interface GroupSummary {
  label: string;
  busy: number;
  idle: number;
  total: number;
  status: GroupStatus;
}

function summarize(
  label: string,
  procs: SystemProcess[],
  agents: Agent[],
  role: string,
): GroupSummary | null {
  // Only show groups that have at least one running process
  const running = procs.filter((p) => p.status === "running");
  if (running.length === 0) return null;

  // Match agents by role to determine busy vs idle
  const roleAgents = agents.filter((a) => a.role === role);
  const busy = roleAgents.filter((a) => a.status === "busy").length;
  const idle = roleAgents.filter((a) => a.status === "idle").length;
  const failed = procs.filter((p) => p.status === "failed").length;

  let status: GroupStatus;
  if (failed > 0) status = "failed";
  else if (busy > 0) status = "busy";
  else status = "idle";

  return {
    label,
    busy,
    idle,
    total: running.length,
    status,
  };
}

function buildSummaries(
  processes: SystemProcess[],
  agents: Agent[],
): GroupSummary[] {
  const groups: [string, (p: SystemProcess) => boolean, string][] = [
    ["Planner", (p) => p.name === "planner" || p.name.startsWith("planner-"), "planner"],
    ["Dispatcher", (p) => p.name === "dispatcher", ""],
    ["Workers", (p) => p.name.startsWith("worker-"), "worker"],
    ["Judges", (p) => p.name === "judge" || p.name.startsWith("judge-"), "judge"],
    ["Cycle Mgr", (p) => p.name === "cycle-manager", ""],
  ];

  const results: GroupSummary[] = [];
  for (const [label, filter, role] of groups) {
    const procs = processes.filter(filter);
    if (procs.length === 0) continue;

    if (!role) {
      // Services without agents (dispatcher, cycle-manager): just show running status
      const running = procs.filter((p) => p.status === "running").length;
      if (running === 0) continue;
      results.push({ label, busy: 0, idle: 0, total: running, status: "idle" });
    } else {
      const s = summarize(label, procs, agents, role);
      if (s) results.push(s);
    }
  }
  return results;
}

const STATUS_DOT: Record<GroupStatus, string> = {
  busy: "bg-yellow-500 animate-pulse",
  idle: "bg-zinc-600",
  completed: "bg-blue-500",
  failed: "bg-red-500",
  offline: "bg-zinc-700",
};

const STATUS_TEXT: Record<GroupStatus, string> = {
  busy: "text-yellow-400",
  idle: "text-zinc-500",
  completed: "text-blue-400",
  failed: "text-red-400",
  offline: "text-zinc-600",
};

function describeActivity(summaries: GroupSummary[]): string | null {
  const parts: string[] = [];

  const planners = summaries.find((s) => s.label === "Planner");
  const workers = summaries.find((s) => s.label === "Workers");
  const judges = summaries.find((s) => s.label === "Judges");

  if (planners?.status === "busy") {
    parts.push("Planner is generating tasks from your requirements");
  }

  if (workers) {
    if (workers.busy > 0) {
      parts.push(
        `${workers.busy} worker${workers.busy > 1 ? "s" : ""} actively processing tasks`,
      );
    } else if (workers.total > 0) {
      parts.push(`${workers.total} worker${workers.total > 1 ? "s" : ""} standing by`);
    }
  }

  if (judges && judges.busy > 0) {
    parts.push(
      `${judges.busy} judge${judges.busy > 1 ? "s" : ""} reviewing completed work`,
    );
  }

  if (summaries.length > 0 && summaries.every((s) => s.status === "idle")) {
    return "All processes standing by — waiting for tasks.";
  }

  return parts.length > 0 ? parts.join(". ") + "." : null;
}

function formatStatus(s: GroupSummary): string {
  if (s.status === "busy") {
    return s.total > 1 ? `BUSY (${s.busy}/${s.total})` : "BUSY";
  }
  if (s.status === "failed") return "FAILED";
  if (s.status === "completed") return "DONE";
  // idle but running process
  return s.total > 1 ? `IDLE (${s.total})` : "IDLE";
}

export const ExecutionProgressCard: React.FC<ExecutionProgressCardProps> = ({
  processes,
  agents = [],
  onViewDetails,
}) => {
  const summaries = buildSummaries(processes, agents);
  const anyBusy = summaries.some((s) => s.status === "busy");
  const activity = describeActivity(summaries);

  if (summaries.length === 0) return null;

  return (
    <div className="py-2 px-3">
      <div className="border border-zinc-700/60 bg-zinc-900/40 p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          {anyBusy && (
            <BrailleSpinner variant="sort" width={6} className="text-yellow-500" />
          )}
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            Live Progress
          </span>
        </div>

        {/* Activity description */}
        {activity && (
          <div className="text-xs text-zinc-300">{activity}</div>
        )}

        {/* Process grid */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {summaries.map((s) => (
            <React.Fragment key={s.label}>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status]}`} />
                <span className="text-[11px] text-zinc-500">{s.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-medium ${STATUS_TEXT[s.status]}`}>
                  {formatStatus(s)}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* View details link */}
        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="text-[11px] text-zinc-600 hover:text-term-tiger transition-colors cursor-pointer"
          >
            &gt; view full dashboard for details
          </button>
        )}
      </div>
    </div>
  );
};
