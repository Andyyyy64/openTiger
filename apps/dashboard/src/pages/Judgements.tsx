import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { judgementsApi, type JudgementEvent } from '../lib/api';
import { ShieldCheck, GitPullRequest, CheckCircle2, Bot } from 'lucide-react';

export const JudgementsPage: React.FC = () => {
  const { data: judgements, isLoading, error } = useQuery({
    queryKey: ['judgements'],
    queryFn: () => judgementsApi.list({ limit: 50 }),
  });

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
        <ShieldCheck className="text-green-400" />
        Judge Reviews
      </h1>

      {isLoading && (
        <div className="text-center text-slate-500 py-12">Loading reviews...</div>
      )}
      {error && (
        <div className="text-center text-red-400 py-12">Error loading reviews</div>
      )}

      <div className="space-y-6">
        {(judgements ?? []).length === 0 && !isLoading && !error && (
          <div className="text-center text-slate-500 py-12">No reviews found</div>
        )}

        {(judgements ?? []).map((event) => (
          <JudgementCard key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
};

const JudgementCard = ({ event }: { event: JudgementEvent }) => {
  const payload = event.payload ?? {};
  const verdict = payload.verdict ?? 'unknown';
  const actions = payload.actions ?? {};
  const ciStatus = payload.summary?.ci?.status ?? (payload.summary?.ci?.pass ? 'success' : 'unknown');
  const policyPass = payload.summary?.policy?.pass;
  const llmPass = payload.summary?.llm?.pass;
  const llmConfidence = payload.summary?.llm?.confidence;
  const codeIssueCount = payload.summary?.llm?.codeIssues?.length ?? 0;
  const violations = payload.summary?.policy?.violations ?? [];
  const prNumber = payload.prNumber;
  const prUrl = payload.prUrl;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="text-xs text-slate-500">
            {new Date(event.createdAt).toLocaleString()}
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${getVerdictColor(verdict)}`}>
              {verdict}
            </span>
            <span className="text-xs text-slate-400">Task:</span>
            <Link to={`/tasks/${event.taskId}`} className="text-xs text-yellow-500 hover:underline">
              {event.taskId.slice(0, 8)}...
            </Link>
            {payload.runId && (
              <Link to={`/runs/${payload.runId}`} className="text-xs text-slate-400 hover:underline">
                Run {payload.runId.slice(0, 8)}...
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span>Judge: {event.agentId ?? 'judge'}</span>
            {payload.riskLevel && <span>Risk: {payload.riskLevel}</span>}
            {typeof payload.confidence === 'number' && (
              <span>Confidence: {Math.round(payload.confidence * 100)}%</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${getStatusChip(ciStatus)}`}>
            CI {ciStatus}
          </span>
          <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${policyPass ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            Policy {policyPass ? 'pass' : 'fail'}
          </span>
          <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${llmPass ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'}`}>
            LLM {llmPass ? 'pass' : 'review'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider">
            <GitPullRequest size={14} />
            Merge
          </div>
          <div className="text-sm text-slate-300 space-y-1">
            <div>Auto-merge: {payload.autoMerge ? 'enabled' : 'disabled'}</div>
            <div>Commented: {actions.commented ? 'yes' : 'no'}</div>
            <div>Approved: {actions.approved ? 'yes' : 'no'}</div>
            <div>Merged: {actions.merged ? 'yes' : 'no'}</div>
            {payload.mergeResult && (
              <div className={payload.mergeResult.success ? 'text-green-400' : 'text-red-400'}>
                Local merge: {payload.mergeResult.success ? 'success' : payload.mergeResult.error ?? 'failed'}
              </div>
            )}
            {prNumber && (
              <div className="flex items-center gap-2">
                <span>PR:</span>
                {prUrl ? (
                  <a href={prUrl} target="_blank" rel="noreferrer" className="text-yellow-500 hover:underline">
                    #{prNumber}
                  </a>
                ) : (
                  <span>#{prNumber}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider">
            <CheckCircle2 size={14} />
            Evaluation
          </div>
          <div className="text-sm text-slate-300 space-y-1">
            <div>CI status: {ciStatus}</div>
            <div>Policy violations: {violations.length}</div>
            <div>LLM issues: {codeIssueCount}</div>
            {typeof llmConfidence === 'number' && (
              <div>LLM confidence: {Math.round(llmConfidence * 100)}%</div>
            )}
          </div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider">
            <Bot size={14} />
            Notes
          </div>
          <div className="text-sm text-slate-300 space-y-2">
            {payload.reasons && payload.reasons.length > 0 && (
              <div>
                <div className="text-xs uppercase text-slate-500">Reasons</div>
                <ul className="text-sm text-slate-300 space-y-1">
                  {payload.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {payload.suggestions && payload.suggestions.length > 0 && (
              <div>
                <div className="text-xs uppercase text-slate-500">Suggestions</div>
                <ul className="text-sm text-slate-300 space-y-1">
                  {payload.suggestions.map((suggestion, index) => (
                    <li key={index}>{suggestion}</li>
                  ))}
                </ul>
              </div>
            )}
            {!payload.reasons?.length && !payload.suggestions?.length && (
              <div className="text-slate-500">No notes recorded</div>
            )}
          </div>
        </div>
      </div>
    </section>
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

const getStatusChip = (status: string) => {
  switch (status) {
    case 'success':
      return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'failure':
      return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'pending':
      return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    case 'error':
      return 'bg-red-500/10 text-red-400 border border-red-500/20';
    default:
      return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};
