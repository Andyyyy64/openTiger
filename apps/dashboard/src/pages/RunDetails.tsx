import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { runsApi, judgementsApi, type JudgementEvent } from '../lib/api';
import { ChevronLeft, Terminal, Box, Link as LinkIcon, AlertCircle, ShieldCheck } from 'lucide-react';
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

  if (isLoading) return <div className="p-8 text-center text-slate-500">Loading run details...</div>;
  if (error || !data) return <div className="p-8 text-center text-red-400">Error loading run details</div>;

  const { run, artifacts } = data;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link to="/runs" className="flex items-center gap-2 text-slate-400 hover:text-white mb-6 transition-colors">
        <ChevronLeft size={20} />
        Back to Runs
      </Link>

      <div className="flex justify-between items-start mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${getStatusColor(run.status)}`}>
              {run.status}
            </span>
            <span className="text-slate-500 text-sm">Run ID: {run.id}</span>
          </div>
          <h1 className="text-4xl font-bold">Execution by {run.agentId}</h1>
          <p className="text-slate-400 mt-2">
            Task: <Link to={`/tasks/${run.taskId}`} className="text-yellow-500 hover:underline">{run.taskId}</Link>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Error Message if failed */}
          {run.errorMessage && (
            <section className="bg-red-500/10 border border-red-500/20 rounded-xl p-6">
              <h2 className="text-red-400 font-semibold mb-2 flex items-center gap-2">
                <AlertCircle size={20} />
                Error Message
              </h2>
              <p className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                {run.errorMessage}
              </p>
            </section>
          )}

          {/* Logs / Output (Placeholder) */}
          <section className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
            <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center gap-2">
              <Terminal size={16} className="text-slate-400" />
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Console Output</span>
            </div>
            <div className="p-6 font-mono text-sm text-slate-300 min-h-[300px]">
              {run.logPath ? (
                <div className="text-slate-500 italic">Logs are stored at: {run.logPath}</div>
              ) : (
                <div className="text-slate-500 italic">No logs available for this run.</div>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {/* Run Stats */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">Run Stats</h2>
            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Tokens Used</span>
                <span className="text-white font-medium">{run.costTokens ?? 0}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Started</span>
                <span className="text-white font-medium">{new Date(run.startedAt).toLocaleTimeString()}</span>
              </div>
              {run.finishedAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Finished</span>
                  <span className="text-white font-medium">{new Date(run.finishedAt).toLocaleTimeString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Artifacts */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">Artifacts</h2>
            <div className="space-y-3">
              {artifacts?.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No artifacts generated</p>
              ) : (
                artifacts?.map((artifact: Artifact) => (
                  <div key={artifact.id} className="flex items-center justify-between p-2 bg-slate-950 rounded border border-slate-800">
                    <div className="flex items-center gap-2">
                      <Box size={14} className="text-blue-400" />
                      <span className="text-xs font-medium text-slate-300">{artifact.type.toUpperCase()}</span>
                    </div>
                    {artifact.url && (
                      <a href={artifact.url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-yellow-500">
                        <LinkIcon size={14} />
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Judge Review */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
              <ShieldCheck size={16} />
              Judge Review
            </h2>
            <div className="space-y-3">
              {(judgements ?? []).length === 0 && (
                <p className="text-xs text-slate-500 italic">No reviews recorded</p>
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
    case 'success': return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'failed': return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'running': return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
    default: return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};

const JudgeReviewItem = ({ review }: { review: JudgementEvent }) => {
  const payload = review.payload ?? {};
  const verdict = payload.verdict ?? 'unknown';
  const merged = payload.actions?.merged ?? false;
  const ciStatus = payload.summary?.ci?.status ?? (payload.summary?.ci?.pass ? 'success' : 'unknown');

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${getVerdictColor(verdict)}`}>
          {verdict}
        </span>
        <span className="text-xs text-slate-500">
          {new Date(review.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="text-xs text-slate-400 space-y-1">
        <div>CI: {ciStatus}</div>
        <div>Auto-merge: {payload.autoMerge ? 'enabled' : 'disabled'}</div>
        <div>Merged: {merged ? 'yes' : 'no'}</div>
      </div>
      {payload.prUrl && (
        <a href={payload.prUrl} target="_blank" rel="noreferrer" className="text-xs text-yellow-500 hover:underline">
          PR #{payload.prNumber}
        </a>
      )}
    </div>
  );
};

const getVerdictColor = (verdict: string) => {
  switch (verdict) {
    case 'approve':
      return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'request_changes':
      return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'needs_human':
      return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    default:
      return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};
