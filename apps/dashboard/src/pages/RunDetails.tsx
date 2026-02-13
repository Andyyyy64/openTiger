import React from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  runsApi,
  judgementsApi,
  systemApi,
  type JudgementEvent,
  resolveProcessNameFromAgentId,
} from "../lib/api";
import type { Artifact } from "@openTiger/core";
import { getRunStatusColor } from "../ui/status";

export const RunDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["runs", id],
    queryFn: () => runsApi.get(id!),
    enabled: !!id,
  });

  const { data: judgements } = useQuery({
    queryKey: ["judgements", id],
    queryFn: () => judgementsApi.list({ runId: id! }),
    enabled: !!id,
  });

  const logRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data?.run?.logContent]);

  const processName = resolveProcessNameFromAgentId(data?.run?.agentId);
  const canStop = data?.run?.status === "running" && Boolean(processName);
  const stopMutation = useMutation({
    mutationFn: async () => {
      if (!processName) {
        throw new Error("No controllable process is bound to this run");
      }
      await systemApi.stopProcess(processName);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["runs", id] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["system", "processes"] });
    },
  });

  if (isLoading)
    return (
      <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">
        &gt; Loading run sequence...
      </div>
    );
  if (error || !data)
    return (
      <div className="p-8 text-center text-red-500 font-mono">&gt; ERR: Run data inaccessible</div>
    );

  const { run, artifacts } = data;

  const handleStop = () => {
    if (!canStop || stopMutation.isPending) {
      return;
    }
    if (!window.confirm(`Stop ${processName} and cancel the current task?`)) {
      return;
    }
    stopMutation.mutate();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto text-term-fg font-mono">
      <Link
        to="/runs"
        className="inline-block text-xs text-zinc-500 hover:text-term-tiger mb-6 group"
      >
        &lt; cd ..
      </Link>

      <div className="flex flex-wrap justify-between items-start mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className={`text-xs font-bold ${getRunStatusColor(run.status)}`}>
              [{run.status.toUpperCase()}]
            </span>
            <span className="text-zinc-500 text-xs">ID: {run.id}</span>
          </div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
            &gt; Exec_Trace@{run.agentId}
          </h1>
          <p className="text-zinc-500 text-xs mt-1">
            TARGET_TASK:{" "}
            <Link to={`/tasks/${run.taskId}`} className="hover:text-term-fg underline">
              {run.taskId}
            </Link>
          </p>
          {stopMutation.isError && (
            <p className="text-red-400 text-xs mt-2">
              STOP_FAILED: {stopMutation.error instanceof Error ? stopMutation.error.message : "error"}
            </p>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={handleStop}
            disabled={!canStop || stopMutation.isPending}
            className={`px-3 py-2 text-xs border uppercase tracking-widest font-bold ${
              canStop && !stopMutation.isPending
                ? "border-red-500 text-red-400 hover:bg-red-500/10"
                : "border-zinc-700 text-zinc-500 cursor-not-allowed"
            }`}
          >
            {stopMutation.isPending ? "STOPPING..." : "STOP"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Error Message if failed */}
          {run.errorMessage && (
            <section className="border border-red-500/50 bg-red-900/10 p-4">
              <h2 className="text-red-500 font-bold text-sm uppercase mb-2">
                ! CRITICAL_FAILURE !
              </h2>
              <p className="text-red-400 text-xs whitespace-pre-wrap">{run.errorMessage}</p>
            </section>
          )}

          {/* Logs / Output */}
          <section className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                System_Log_Output
              </span>
            </div>
            <div
              ref={logRef}
              className="p-4 bg-black text-xs text-zinc-300 min-h-[300px] max-h-[600px] overflow-auto whitespace-pre font-mono"
            >
              {run.logContent ? (
                run.logContent
              ) : run.logPath ? (
                <div className="text-zinc-500 italic">// Log file archived at: {run.logPath}</div>
              ) : (
                <div className="text-zinc-600 italic">// Buffer empty. No output recorded.</div>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {/* Run Stats */}
          <div className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-widest">Metrics</h2>
            </div>
            <div className="p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">TOKEN_USAGE</span>
                <span className="text-term-fg">{run.costTokens ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">INIT_TIME</span>
                <span className="text-term-fg">{new Date(run.startedAt).toLocaleTimeString()}</span>
              </div>
              {run.finishedAt && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">EXIT_TIME</span>
                  <span className="text-term-fg">
                    {new Date(run.finishedAt).toLocaleTimeString()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Artifacts */}
          <div className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-widest">Generated_Artifacts</h2>
            </div>
            <div className="p-4 space-y-2">
              {artifacts?.length === 0 ? (
                <p className="text-xs text-zinc-600 italic">// No artifacts found</p>
              ) : (
                artifacts?.map((artifact: Artifact) => (
                  <div key={artifact.id} className="flex items-center justify-between group">
                    <span className="text-xs text-term-fg">- {artifact.type.toUpperCase()}</span>
                    {artifact.url && (
                      <a
                        href={artifact.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-term-tiger hover:underline"
                      >
                        [OPEN]
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Judge Review */}
          <div className="border border-term-border p-0">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
              <h2 className="text-sm font-bold uppercase tracking-widest">
                Audit_Log (Judgements)
              </h2>
            </div>
            <div className="divide-y divide-term-border">
              {(judgements ?? []).length === 0 && (
                <div className="p-4 text-xs text-zinc-600 italic">// No audit records</div>
              )}
              {(judgements ?? []).map((review) => (
                <JudgeReviewItem key={review.id} review={review} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const JudgeReviewItem = ({ review }: { review: JudgementEvent }) => {
  const payload = review.payload ?? {};
  const verdict = normalizeLegacyVerdict(payload.verdict ?? "unknown");
  const merged = payload.actions?.merged ?? false;
  const ciStatus =
    payload.summary?.ci?.status ?? (payload.summary?.ci?.pass ? "success" : "unknown");

  return (
    <div className="p-3 space-y-1 hover:bg-term-fg/5 transition-colors">
      <div className="flex items-center justify-between">
        <span className={`text-xs font-bold ${getVerdictColor(verdict)}`}>
          [{verdict.toUpperCase()}]
        </span>
        <span className="text-[10px] text-zinc-600">
          {new Date(review.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="text-[10px] text-zinc-400 grid grid-cols-2 gap-x-2">
        <span>CI: {ciStatus.toUpperCase()}</span>
        <span>AUTO_MERGE: {payload.autoMerge ? "ON" : "OFF"}</span>
        <span>MERGED: {merged ? "YES" : "NO"}</span>
      </div>
      {payload.prUrl && (
        <a
          href={payload.prUrl}
          target="_blank"
          rel="noreferrer"
          className="block text-[10px] text-blue-400 hover:underline mt-1"
        >
          &gt; VIEW PR #{payload.prNumber}
        </a>
      )}
    </div>
  );
};

const getVerdictColor = (verdict: string) => {
  switch (verdict) {
    case "approve":
      return "text-term-tiger";
    case "request_changes":
      return "text-red-500";
    default:
      return "text-zinc-500";
  }
};

function normalizeLegacyVerdict(verdict: string): string {
  return verdict === "needs_human" ? "request_changes" : verdict;
}
