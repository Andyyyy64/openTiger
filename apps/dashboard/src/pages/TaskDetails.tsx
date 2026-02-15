import React from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { plansApi, runsApi, tasksApi, type PolicyRecoveryHintApplication } from "../lib/api";
import {
  getRunStatusColor,
  getTaskRiskColor,
  getTaskStatusColor,
  formatTaskRetryStatus,
} from "../ui/status";

const REWORK_PARENT_PATTERN = /\[auto-rework\] parentTask=([0-9a-f-]{36})/i;

export const TaskDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: task, isLoading: isTaskLoading } = useQuery({
    queryKey: ["tasks", id],
    queryFn: () => tasksApi.get(id!),
    enabled: !!id,
  });

  const { data: runs, isLoading: isRunsLoading } = useQuery({
    queryKey: ["tasks", id, "runs"],
    queryFn: () => runsApi.list(id!),
    enabled: !!id,
  });
  const { data: allTasks } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => tasksApi.list(),
    enabled: !!id,
  });
  const { data: plans } = useQuery({
    queryKey: ["plans", "task-details-growth"],
    queryFn: () => plansApi.list(50),
    enabled: !!id,
  });

  const growthApplications = React.useMemo<
    Array<{
      planId: string;
      planCreatedAt: string;
      application: PolicyRecoveryHintApplication;
    }>
  >(() => {
    if (!task || !plans) {
      return [];
    }
    const evidence: Array<{
      planId: string;
      planCreatedAt: string;
      application: PolicyRecoveryHintApplication;
    }> = [];
    for (const plan of plans) {
      const taskIndex = plan.taskIds.indexOf(task.id);
      if (taskIndex < 0) {
        continue;
      }
      const applications = plan.policyRecoveryHintApplications ?? [];
      const matchedByIndex = applications.filter(
        (application) => application.taskIndex === taskIndex,
      );
      if (matchedByIndex.length > 0) {
        for (const application of matchedByIndex) {
          evidence.push({
            planId: plan.id,
            planCreatedAt: plan.createdAt,
            application,
          });
        }
        continue;
      }

      const taskTitle = plan.tasks.find((candidate) => candidate.id === task.id)?.title;
      if (!taskTitle) {
        continue;
      }
      const matchedByTitle = applications.filter(
        (application) => application.taskTitle === taskTitle,
      );
      for (const application of matchedByTitle) {
        evidence.push({
          planId: plan.id,
          planCreatedAt: plan.createdAt,
          application,
        });
      }
    }
    return evidence;
  }, [plans, task]);

  const replacedByReworkParentIds = React.useMemo(() => {
    const parentIds = new Set<string>();
    for (const candidate of allTasks ?? []) {
      const notes = candidate.context?.notes ?? "";
      const matched = notes.match(REWORK_PARENT_PATTERN);
      const parentId = matched?.[1];
      if (parentId) {
        parentIds.add(parentId);
      }
    }
    return parentIds;
  }, [allTasks]);

  const isReworkReplaced =
    task?.status === "cancelled" && task?.id ? replacedByReworkParentIds.has(task.id) : false;

  if (isTaskLoading)
    return (
      <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">
        &gt; Loading task data...
      </div>
    );
  if (!task)
    return (
      <div className="p-8 text-center text-red-500 font-mono">
        &gt; ERR: Task not found in registry
      </div>
    );

  return (
    <div className="p-6 max-w-5xl mx-auto text-term-fg font-mono">
      <Link
        to="/tasks"
        className="inline-block text-xs text-zinc-500 hover:text-term-tiger mb-6 group"
      >
        &lt; cd ..
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-start mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className={`text-xs font-bold ${getTaskStatusColor(task.status)}`}>
              [{task.status.toUpperCase()}]
            </span>
            {isReworkReplaced && (
              <span className="text-[10px] uppercase tracking-wide text-zinc-400">
                replaced by rework
              </span>
            )}
            <span className="text-zinc-500 text-xs">ID: {task.id}</span>
          </div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
            &gt; Task: {task.title}
          </h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Goal Section */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">
                01_Objective_&_Criteria
              </h2>
            </div>
            <div className="p-4">
              <p className="text-zinc-300 text-sm whitespace-pre-wrap leading-relaxed">
                {task.goal}
              </p>
            </div>
          </section>

          {/* Context Section */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">02_Context_Data</h2>
            </div>
            <div className="p-4 space-y-4">
              {task.context?.specs && (
                <div>
                  <h3 className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wide">
                    Specifications
                  </h3>
                  <div className="border-l-2 border-zinc-700 pl-2 text-zinc-400 text-xs">
                    {task.context.specs}
                  </div>
                </div>
              )}
              {task.context?.files && task.context.files.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wide">
                    Related Files
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {task.context.files.map((file: string, i: number) => (
                      <span
                        key={i}
                        className="text-xs text-zinc-300 bg-zinc-900 px-2 py-0.5 border border-zinc-800"
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Execution History */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Execution_Log</h2>
            </div>
            <div className="overflow-x-auto">
              {isRunsLoading ? (
                <div className="p-8 text-center text-zinc-500 animate-pulse">
                  &gt; Fetching history...
                </div>
              ) : runs?.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 italic">
                  // No execution history found.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500 border-b border-term-border">
                    <tr>
                      <th className="px-4 py-2 font-normal uppercase">Agent_ID</th>
                      <th className="px-4 py-2 font-normal uppercase">Status</th>
                      <th className="px-4 py-2 font-normal uppercase">Duration</th>
                      <th className="px-4 py-2 font-normal uppercase">Started_At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-term-border">
                    {runs?.map((run) => (
                      <tr
                        key={run.id}
                        onClick={() => navigate(`/runs/${run.id}`)}
                        className="hover:bg-term-fg/5 transition-colors cursor-pointer group"
                      >
                        <td className="px-4 py-2 text-term-fg group-hover:text-term-tiger">
                          {run.agentId}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`font-bold ${getRunStatusColor(run.status)}`}>
                            [{run.status.toUpperCase()}]
                          </span>
                        </td>
                        <td className="px-4 py-2 text-zinc-400">
                          {run.finishedAt
                            ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                            : "-"}
                        </td>
                        <td className="px-4 py-2 text-zinc-500">
                          {new Date(run.startedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {/* Configuration Card */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Params</h2>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">RISK_LEVEL</span>
                <span className={`font-bold ${getTaskRiskColor(task.riskLevel)}`}>
                  {task.riskLevel.toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">PRIORITY</span>
                <span className="text-term-fg">{task.priority}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">ROLE</span>
                <span className="text-term-fg">{task.role?.toUpperCase() ?? "WORKER"}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">TIMEBOX</span>
                <span className="text-term-fg">{task.timeboxMinutes}m</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">RETRY</span>
                <span className="text-term-fg">{formatTaskRetryStatus(task.retry, now)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">RETRY_COUNT</span>
                <span className="text-term-fg">
                  {task.retry?.retryCount ?? task.retryCount}/
                  {task.retry?.retryLimit === -1 ? "∞" : (task.retry?.retryLimit ?? "-")}
                </span>
              </div>
            </div>
          </section>

          {/* Allowed Paths */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Scope: Allowed_Paths</h2>
            </div>
            <div className="p-4 space-y-1">
              {task.allowedPaths.map((path: string, i: number) => (
                <div key={i} className="text-xs font-mono text-zinc-400 break-all">
                  - {path}
                </div>
              ))}
              {task.allowedPaths.length === 0 && (
                <div className="text-xs text-zinc-600 italic">// No paths defined</div>
              )}
            </div>
          </section>

          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Growth: Policy_Hints</h2>
            </div>
            <div className="p-4 space-y-4">
              {growthApplications.length === 0 ? (
                <div className="text-xs text-zinc-600 italic">
                  // No policy growth evidence for this task yet
                </div>
              ) : (
                growthApplications.map((entry, entryIndex) => (
                  <div key={`${entry.planId}-${entryIndex}`} className="border border-zinc-800 p-3">
                    <div className="text-[11px] text-zinc-500 mb-2">
                      PLAN {entry.planId.slice(0, 8)} @{" "}
                      {new Date(entry.planCreatedAt).toLocaleString()}
                    </div>
                    <div className="space-y-1 mb-3">
                      <div className="text-[11px] text-zinc-500 uppercase">Added Allowed Paths</div>
                      {entry.application.addedAllowedPaths.map((path, pathIndex) => (
                        <div
                          key={`${entry.planId}-${entryIndex}-path-${pathIndex}`}
                          className="text-xs text-term-tiger break-all"
                        >
                          + {path}
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] text-zinc-500 uppercase">Hint Basis</div>
                      {entry.application.matchedHints.map((hint, hintIndex) => (
                        <div
                          key={`${entry.planId}-${entryIndex}-hint-${hintIndex}`}
                          className="text-xs text-zinc-400 wrap-break-word"
                        >
                          {hint.path} | reason={hint.reason} | role={hint.hintRole ?? "any"} | seen=
                          {hint.hintCount}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Commands */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Verification_Cmds</h2>
            </div>
            <div className="p-4 space-y-1">
              {task.commands.map((cmd: string, i: number) => (
                <div key={i} className="text-xs font-mono text-yellow-500 break-all">
                  $ {cmd}
                </div>
              ))}
              {task.commands.length === 0 && (
                <div className="text-xs text-zinc-600 italic">// No commands defined</div>
              )}
            </div>
          </section>

          {/* Dependencies */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-wider">Dependencies</h2>
            </div>
            <div className="p-4">
              {task.dependencies?.length ? (
                <div className="space-y-1">
                  {task.dependencies.map((dependencyId: string) => (
                    <Link
                      key={dependencyId}
                      to={`/tasks/${dependencyId}`}
                      className="block text-xs font-mono text-term-fg hover:text-term-tiger hover:underline break-all"
                    >
                      &gt; {dependencyId}
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-600 italic">// No dependencies</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
