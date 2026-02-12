import React from "react";
import { useQuery } from "@tanstack/react-query";
import { runsApi, tasksApi } from "../lib/api";
import { Link, useNavigate } from "react-router-dom";
import type { Run } from "@openTiger/core";
import type { TaskView } from "../lib/api";
import {
  formatQuotaWaitRetryStatus,
  formatTaskRetryStatus,
  getRunStatusColor,
  isWaitingRetryStatus,
} from "../ui/status";

export const RunsPage: React.FC = () => {
  const [now, setNow] = React.useState(Date.now());
  const navigate = useNavigate();

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const {
    data: runs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["runs"],
    queryFn: () => runsApi.list(),
  });
  const { data: tasks } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => tasksApi.list(),
  });
  const taskById = React.useMemo(() => {
    const map = new Map<string, TaskView>();
    for (const task of tasks ?? []) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);
  const groupedRuns = React.useMemo(
    () => groupRunsByTaskGroup(runs ?? [], taskById),
    [runs, taskById],
  );

  return (
    <div className="p-6 text-term-fg">
      <h1 className="text-xl font-bold mb-8 uppercase tracking-widest text-term-tiger font-pixel">
        &gt; Execution_Values (Runs)
      </h1>

      <div className="space-y-6">
        {isLoading ? (
          <div className="text-center text-zinc-500 py-12 font-mono animate-pulse">
            &gt; Loading execution values...
          </div>
        ) : error ? (
          <div className="text-center text-red-500 py-12 font-mono">&gt; ERROR LOADING DATA</div>
        ) : groupedRuns.length === 0 ? (
          <div className="text-center text-zinc-500 py-12 font-mono">&gt; No records found</div>
        ) : (
          groupedRuns.map((group) => {
            const latestRun = group.runs[0];
            const primaryTaskId = latestRun.taskId;
            const displayTask =
              taskById.get(primaryTaskId) ??
              group.taskIds.map((id) => taskById.get(id)).find(Boolean);
            const tasksInGroup = group.taskIds
              .map((id) => taskById.get(id))
              .filter((t): t is TaskView => Boolean(t));
            const retryTask =
              tasksInGroup.find((t) => t.retry?.autoRetry && t.retry.reason === "quota_wait") ??
              tasksInGroup.find(
                (t) => t.retry && isWaitingRetryStatus(formatTaskRetryStatus(t.retry, now)),
              ) ??
              displayTask;
            const retryStatus = formatTaskRetryStatus(retryTask?.retry, now);
            const hasQuotaRetryInfo = tasksInGroup.some(
              (t) => t.retry?.autoRetry && t.retry.reason === "quota_wait",
            );
            const latestRunQuotaFailure = Boolean(
              latestRun &&
              latestRun.status === "failed" &&
              isQuotaErrorMessage(latestRun.errorMessage),
            );
            const isQuotaWaiting = hasQuotaRetryInfo || latestRunQuotaFailure;
            const effectiveRetryStatus = isQuotaWaiting
              ? formatQuotaWaitRetryStatus(
                  tasksInGroup.find((t) => t.retry?.reason === "quota_wait")?.retry ??
                    displayTask?.retry,
                  now,
                )
              : retryStatus;
            const isRetryWaiting = isWaitingRetryStatus(effectiveRetryStatus);
            const isJudgeWaiting =
              /^judge \d+s$/.test(effectiveRetryStatus) || effectiveRetryStatus === "judge due";
            const retryLabel =
              effectiveRetryStatus !== "pending" &&
              effectiveRetryStatus !== "due" &&
              effectiveRetryStatus !== "--" ? (
                <span
                  className={
                    isRetryWaiting
                      ? "text-term-tiger font-bold animate-pulse"
                      : "text-term-tiger font-bold"
                  }
                >
                  {effectiveRetryStatus}
                </span>
              ) : (
                <span
                  className={isRetryWaiting ? "text-term-tiger animate-pulse" : "text-zinc-500"}
                >
                  {effectiveRetryStatus}
                </span>
              );

            return (
              <section
                key={group.groupKey}
                className={`border p-0 ${isQuotaWaiting ? "border-yellow-500/70 shadow-[0_0_0_1px_rgba(250,204,21,0.2)]" : isRetryWaiting ? "border-term-tiger/60 animate-pulse" : "border-term-border"}`}
              >
                {/* Task Header */}
                <div className="bg-term-border/10 px-4 py-3 border-b border-term-border flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 max-w-[70%]">
                    <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
                      <span className="text-zinc-500">task:</span>
                      {group.taskIds.map((tid) => (
                        <Link
                          key={tid}
                          to={`/tasks/${tid}`}
                          className="text-term-tiger hover:underline font-bold"
                        >
                          {tid.slice(0, 8)}
                        </Link>
                      ))}
                      {group.taskIds.length > 1 && (
                        <span className="text-zinc-600">(same work)</span>
                      )}
                    </div>
                    {displayTask?.title && (
                      <div className="text-sm font-bold text-term-fg truncate">
                        {displayTask.title}
                      </div>
                    )}
                  </div>

                  <div className="text-right text-xs font-mono text-zinc-500 space-y-1">
                    <div className="flex items-center justify-end gap-4">
                      <span>{group.runs.length} runs</span>
                      <span className="text-zinc-600">|</span>
                      <span>latest: {new Date(latestRun.startedAt).toLocaleString()}</span>
                    </div>
                    <div className="text-sm leading-tight">retry: {retryLabel}</div>
                  </div>
                </div>

                {isQuotaWaiting && (
                  <div className="px-4 py-2 border-b border-yellow-500/40 bg-yellow-500/5 text-xs font-mono flex items-center justify-between gap-4">
                    <span className="text-yellow-400 font-bold uppercase tracking-wider">
                      [WAITING_QUOTA]
                    </span>
                    <span className="text-yellow-300">
                      {effectiveRetryStatus === "quota due"
                        ? "retrying now"
                        : `next retry: ${effectiveRetryStatus}`}
                    </span>
                  </div>
                )}
                {isRetryWaiting && !isQuotaWaiting && (
                  <div className="px-4 py-2 border-b border-term-tiger/40 bg-term-tiger/5 text-xs font-mono flex items-center justify-between gap-4 animate-pulse">
                    <span className="text-term-tiger font-bold uppercase tracking-wider">
                      {isJudgeWaiting ? "[JUDGE_WAIT]" : "[RETRY_WAIT]"}
                    </span>
                    <span className="text-term-tiger/90">
                      {effectiveRetryStatus === "due" ||
                      effectiveRetryStatus === "rework due" ||
                      effectiveRetryStatus === "judge due"
                        ? "retrying now"
                        : `next retry: ${effectiveRetryStatus}`}
                    </span>
                  </div>
                )}

                {/* Runs Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left bg-transparent font-mono text-xs">
                    <thead className="text-zinc-500 uppercase border-b border-term-border bg-term-bg">
                      <tr>
                        <th className="px-4 py-2 font-normal w-32">Run ID</th>
                        <th className="px-4 py-2 font-normal w-32">Agent</th>
                        <th className="px-4 py-2 font-normal w-24">Status</th>
                        <th className="px-4 py-2 font-normal w-24">Duration</th>
                        <th className="px-4 py-2 font-normal">Started</th>
                        <th className="px-4 py-2 font-normal text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-term-border">
                      {group.runs.map((run) =>
                        (() => {
                          const isLatestRun = run.id === latestRun.id;
                          const showQuotaWaitStatus =
                            isLatestRun && isQuotaWaiting && run.status === "failed";
                          const showJudgeWaitStatus =
                            isLatestRun && isJudgeWaiting && !isQuotaWaiting;
                          const showRetryWaitStatus =
                            isLatestRun &&
                            isRetryWaiting &&
                            !isQuotaWaiting &&
                            !isJudgeWaiting &&
                            run.status === "failed";
                          return (
                            <tr
                              key={run.id}
                              onClick={() => navigate(`/runs/${run.id}`)}
                              className="hover:bg-term-fg/5 transition-colors group cursor-pointer"
                            >
                              <td className="px-4 py-2 align-top text-term-fg">
                                {run.id.slice(0, 8)}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-400">@{run.agentId}</td>
                              <td className="px-4 py-2 align-top">
                                {showQuotaWaitStatus ? (
                                  <span className="uppercase text-yellow-400 animate-pulse font-bold">
                                    [quota_wait]
                                  </span>
                                ) : showJudgeWaitStatus ? (
                                  <span className="uppercase text-term-tiger animate-pulse font-bold">
                                    [judge_wait]
                                  </span>
                                ) : showRetryWaitStatus ? (
                                  <span className="uppercase text-term-tiger animate-pulse font-bold">
                                    [retry_wait]
                                  </span>
                                ) : (
                                  <span className={`uppercase ${getRunStatusColor(run.status)}`}>
                                    [{run.status}]
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-500">
                                {run.finishedAt
                                  ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                                  : "--"}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-600">
                                {new Date(run.startedAt).toLocaleString()}
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                <span className="text-term-tiger text-[10px] opacity-60 group-hover:opacity-100 hover:underline">
                                  OPEN &gt;
                                </span>
                              </td>
                            </tr>
                          );
                        })(),
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
};

function isQuotaErrorMessage(errorMessage: string | null | undefined): boolean {
  const normalized = (errorMessage ?? "").toLowerCase();
  return (
    normalized.includes("quota") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("429")
  );
}

const REWORK_PARENT_PREFIX = "[auto-rework] parentTask=";
const DOCSER_SOURCE_PREFIX = "sourceTaskId: ";

function getTaskGroupKey(
  task: TaskView,
  taskById: Map<string, TaskView>,
  seen = new Set<string>(),
): string {
  const ctx = task.context as Record<string, unknown> | undefined;
  if (!ctx) return task.id;

  const pr = ctx.pr as { sourceTaskId?: string } | undefined;
  if (pr?.sourceTaskId) return pr.sourceTaskId;

  const supersededPr = ctx.supersededPr as { sourceTaskId?: string } | undefined;
  if (supersededPr?.sourceTaskId) return supersededPr.sourceTaskId;

  const notes = (ctx.notes as string | undefined) ?? "";
  const parentMatch = notes.match(
    new RegExp(
      `${REWORK_PARENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-f-]{36})`,
      "i",
    ),
  );
  if (parentMatch) {
    const parentId = parentMatch[1];
    if (seen.has(parentId)) return task.id;
    seen.add(parentId);
    const parent = taskById.get(parentId);
    return parent ? getTaskGroupKey(parent, taskById, seen) : parentId;
  }

  const docserMatch = notes.match(
    new RegExp(`${DOCSER_SOURCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-f-]{36})`),
  );
  if (docserMatch) return docserMatch[1];

  return task.id;
}

// Group runs by logical task (rework/autofix/docser chain share same group)
function groupRunsByTaskGroup(
  runs: Run[],
  taskById: Map<string, TaskView>,
): Array<{ groupKey: string; taskIds: string[]; runs: Run[] }> {
  const groupKeyByTaskId = new Map<string, string>();
  for (const [taskId, task] of taskById) {
    groupKeyByTaskId.set(taskId, getTaskGroupKey(task, taskById));
  }

  const groups = new Map<string, { taskIds: Set<string>; runs: Run[] }>();
  for (const run of runs) {
    const groupKey = groupKeyByTaskId.get(run.taskId) ?? run.taskId;
    let g = groups.get(groupKey);
    if (!g) {
      g = { taskIds: new Set(), runs: [] };
      groups.set(groupKey, g);
    }
    g.taskIds.add(run.taskId);
    g.runs.push(run);
  }

  const result = Array.from(groups.entries()).map(([groupKey, { taskIds, runs: grouped }]) => ({
    groupKey,
    taskIds: Array.from(taskIds),
    runs: grouped,
  }));

  for (const g of result) {
    g.runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }
  result.sort(
    (a, b) =>
      new Date(b.runs[0]?.startedAt ?? 0).getTime() - new Date(a.runs[0]?.startedAt ?? 0).getTime(),
  );
  return result;
}
