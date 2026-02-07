import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { runsApi, judgementsApi, type JudgementEvent } from '../lib/api';
import type { Artifact } from '@sebastian-code/core';

export const RunDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['runs', id],
    queryFn: () => runsApi.get(id!),
    enabled: !!id,
  });

  const { data: judgements } = useQuery({
    queryKey: ['judgements', id],
    queryFn: () => judgementsApi.list({ runId: id! }),
    enabled: !!id,
  });

  const logRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data?.run?.logContent]);

  if (isLoading) return <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">&gt; Loading run sequence...</div>;
  if (error || !data) return <div className="p-8 text-center text-red-500 font-mono">&gt; ERR: Run data inaccessible</div>;

  const { run, artifacts } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto text-[var(--color-term-fg)] font-mono">
      <Link to="/runs" className="inline-block text-xs text-zinc-500 hover:text-[var(--color-term-green)] mb-6 group">
        &lt; cd ..
      </Link>

      <div className="flex flex-wrap justify-between items-start mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className={`text-xs font-bold ${getStatusColor(run.status)}`}>
              [{run.status.toUpperCase()}]
            </span>
            <span className="text-zinc-500 text-xs">ID: {run.id}</span>
          </div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
            &gt; Exec_Trace@{run.agentId}
          </h1>
          <p className="text-zinc-500 text-xs mt-1">
            TARGET_TASK: <Link to={`/tasks/${run.taskId}`} className="hover:text-[var(--color-term-fg)] underline">{run.taskId}</Link>
          </p>
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
              <p className="text-red-400 text-xs whitespace-pre-wrap">
                {run.errorMessage}
              </p>
            </section>
          )}

          {/* Logs / Output */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">System_Log_Output</span>
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
          <div className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-widest">Metrics</h2>
            </div>
            <div className="p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">TOKEN_USAGE</span>
                <span className="text-[var(--color-term-fg)]">{run.costTokens ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">INIT_TIME</span>
                <span className="text-[var(--color-term-fg)]">{new Date(run.startedAt).toLocaleTimeString()}</span>
              </div>
              {run.finishedAt && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">EXIT_TIME</span>
                  <span className="text-[var(--color-term-fg)]">{new Date(run.finishedAt).toLocaleTimeString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Artifacts */}
          <div className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-widest">Generated_Artifacts</h2>
            </div>
            <div className="p-4 space-y-2">
              {artifacts?.length === 0 ? (
                <p className="text-xs text-zinc-600 italic">// No artifacts found</p>
              ) : (
                artifacts?.map((artifact: Artifact) => (
                  <div key={artifact.id} className="flex items-center justify-between group">
                    <span className="text-xs text-[var(--color-term-fg)]">
                      - {artifact.type.toUpperCase()}
                    </span>
                    {artifact.url && (
                      <a href={artifact.url} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-term-green)] hover:underline">
                        [OPEN]
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Judge Review */}
          <div className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-widest">Audit_Log (Judgements)</h2>
            </div>
            <div className="divide-y divide-[var(--color-term-border)]">
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

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success': return 'text-[var(--color-term-green)]';
    case 'failed': return 'text-red-500';
    case 'running': return 'text-blue-400 animate-pulse';
    default: return 'text-zinc-500';
  }
};

const JudgeReviewItem = ({ review }: { review: JudgementEvent }) => {
  const payload = review.payload ?? {};
  const verdict = payload.verdict ?? 'unknown';
  const merged = payload.actions?.merged ?? false;
  const ciStatus = payload.summary?.ci?.status ?? (payload.summary?.ci?.pass ? 'success' : 'unknown');

  return (
    <div className="p-3 space-y-1 hover:bg-[var(--color-term-fg)]/5 transition-colors">
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
        <span>AUTO_MERGE: {payload.autoMerge ? 'ON' : 'OFF'}</span>
        <span>MERGED: {merged ? 'YES' : 'NO'}</span>
      </div>
      {payload.prUrl && (
        <a href={payload.prUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-blue-400 hover:underline mt-1">
          &gt; VIEW PR #{payload.prNumber}
        </a>
      )}
    </div>
  );
};

const getVerdictColor = (verdict: string) => {
  switch (verdict) {
    case 'approve':
      return 'text-[var(--color-term-green)]';
    case 'request_changes':
      return 'text-red-500';
    case 'needs_human':
      return 'text-yellow-500';
    default:
      return 'text-zinc-500';
  }
};

