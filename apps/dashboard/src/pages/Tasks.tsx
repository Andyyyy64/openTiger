import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "../lib/api";
import type { TaskView } from "../lib/api";
import { formatTaskRetryStatus, getTaskRiskColor, getTaskStatusColor } from "../ui/status";

export const TasksPage: React.FC = () => {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const {
    data: tasks,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => tasksApi.list(),
  });

  return (
    <div className="p-6 text-term-fg">
      <div className="mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Task_Scheduler
        </h1>
      </div>

      <div className="border border-term-border">
        <div className="overflow-x-auto">
          <table className="w-full text-left bg-transparent">
            <thead className="bg-term-border/10 text-xs text-zinc-500 uppercase font-pixel">
              <tr>
                <th className="px-4 py-2 font-normal border-b border-term-border">Title</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Status</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Priority</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Risk</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Deps</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Retry</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Created</th>
              </tr>
            </thead>
            <tbody className="font-pixel text-sm divide-y divide-term-border">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500 animate-pulse">
                    &gt; Loading tasks...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-red-500">
                    &gt; ERROR LOADING TASKS
                  </td>
                </tr>
              ) : tasks?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                    &gt; No tasks found
                  </td>
                </tr>
              ) : (
                tasks?.map((task: TaskView) => (
                  <tr key={task.id} className="hover:bg-term-tiger/5 transition-colors group">
                    <td className="px-4 py-2 align-top">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="font-bold text-term-fg hover:text-term-tiger block"
                      >
                        {task.title}
                      </Link>
                      <div className="text-xs text-zinc-600 truncate max-w-xs">{task.goal}</div>
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className={`text-xs uppercase px-1 ${getTaskStatusColor(task.status)}`}>
                        {task.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-400">{task.priority}</td>
                    <td className="px-4 py-2 align-top">
                      <span className={`text-xs ${getTaskRiskColor(task.riskLevel)}`}>
                        {task.riskLevel}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-500">
                      {task.dependencies?.length ?? 0}
                    </td>
                    <td className="px-4 py-2 align-top text-xs text-zinc-400">
                      {formatTaskRetryStatus(task.retry, now)}
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-600">
                      {new Date(task.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
