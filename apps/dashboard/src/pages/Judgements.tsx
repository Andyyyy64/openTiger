import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { judgementsApi, type JudgementEvent } from '../lib/api';

export const JudgementsPage: React.FC = () => {
  const { data: judgements, isLoading, error } = useQuery({
    queryKey: ['judgements'],
    queryFn: () => judgementsApi.list({ limit: 50 }),
  });

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-tiger)] font-pixel">
          &gt; Judge_Audit_Log
        </h1>
        <span className="text-xs text-zinc-500">
          {isLoading ? 'Scanning...' : `${judgements?.length ?? 0} EVENTS LOGGED`}
        </span>
      </div>

      {isLoading && (
        <div className="text-center text-zinc-500 py-12 font-mono animate-pulse">&gt; Retrieving audit logs...</div>
      )}
      {error && (
        <div className="text-center text-red-500 py-12 font-mono">&gt; ERROR: Failed to load logs</div>
      )}

      <div className="space-y-6">
        {(judgements ?? []).length === 0 && !isLoading && !error && (
          <div className="text-center text-zinc-500 py-12 font-mono">&gt; No judgement events recorded</div>
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
  const [showDiff, setShowDiff] = React.useState(false);

  const { data: diffData, isLoading: isDiffLoading, error: diffError } = useQuery({
    queryKey: ['judgements', event.id, 'diff'],
    queryFn: () => judgementsApi.diff(event.id),
    enabled: showDiff,
  });
  const diffErrorMessage = diffError instanceof Error ? diffError.message : 'Could not retrieve diff data.';

  return (
    <section className="border border-[var(--color-term-border)] p-0 font-mono">
      {/* Event Header */}
      <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-zinc-500">{new Date(event.createdAt).toLocaleString()}</span>
          <div className={`font-bold ${getVerdictColor(verdict)}`}>
            [{verdict.toUpperCase()}]
          </div>

          <div className="flex items-center gap-2 text-zinc-400">
            <span>TASK:</span>
            <Link to={`/tasks/${event.taskId}`} className="text-[var(--color-term-tiger)] hover:underline">
              {event.taskId.slice(0, 8)}
            </Link>
          </div>

          {payload.runId && (
            <div className="flex items-center gap-2 text-zinc-500">
              <span>RUN:</span>
              <Link to={`/runs/${payload.runId}`} className="hover:text-zinc-300 hover:underline">
                {payload.runId.slice(0, 8)}
              </Link>
            </div>
          )}
        </div>

        <div className="flex gap-4 text-xs">
          <div className={`${getStatusColor(ciStatus)}`}>
            CI:{ciStatus.toUpperCase()}
          </div>
          <div className={policyPass ? 'text-[var(--color-term-tiger)]' : 'text-red-500'}>
            POLICY:{policyPass ? 'PASS' : 'FAIL'}
          </div>
          <div className={llmPass ? 'text-[var(--color-term-tiger)]' : 'text-yellow-500'}>
            LLM:{llmPass ? 'PASS' : 'REV'}
          </div>
        </div>
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-[var(--color-term-border)] text-xs">
        {/* Merge Info */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Merge_Status</div>
          <div className="grid grid-cols-[100px_1fr] gap-1">
            <span className="text-zinc-500">AUTO_MERGE</span>
            <span>{payload.autoMerge ? 'TRUE' : 'FALSE'}</span>

            <span className="text-zinc-500">PR_LINK</span>
            <span>
              {prNumber ? (
                prUrl ? <a href={prUrl} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">#{prNumber}</a> : <span>#{prNumber}</span>
              ) : <span className="text-zinc-600">N/A</span>}
            </span>

            <span className="text-zinc-500">ACTIONS</span>
            <span>
              {[
                actions.commented && 'COMMENTED',
                actions.approved && 'APPROVED',
                actions.merged && 'MERGED'
              ].filter(Boolean).join(', ') || 'NONE'}
            </span>

            {payload.mergeResult && (
              <>
                <span className="text-zinc-500">LOCAL_MERGE</span>
                <span className={payload.mergeResult.success ? 'text-[var(--color-term-tiger)]' : 'text-red-500'}>
                  {payload.mergeResult.success ? 'SUCCESS' : 'FAILED'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Evaluation Metrics */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Metrics</div>
          <div className="grid grid-cols-[120px_1fr] gap-1">
            <span className="text-zinc-500">CONFIDENCE</span>
            <span>{typeof llmConfidence === 'number' ? `${Math.round(llmConfidence * 100)}%` : 'N/A'}</span>

            <span className="text-zinc-500">ISSUES</span>
            <span>{codeIssueCount} detected</span>

            <span className="text-zinc-500">VIOLATIONS</span>
            <span className={violations.length > 0 ? 'text-red-500' : 'text-zinc-400'}>{violations.length}</span>
          </div>
        </div>

        {/* Notes/Summary */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Notes</div>
          {(payload.reasons?.length || payload.suggestions?.length) ? (
            <ul className="list-disc list-inside text-zinc-400 space-y-1">
              {payload.reasons?.map((r, i) => <li key={`r-${i}`}>{r}</li>)}
              {payload.suggestions?.map((s, i) => <li key={`s-${i}`} className="text-yellow-500/80">{s}</li>)}
            </ul>
          ) : (
            <div className="text-zinc-600 italic">// No notes recorded</div>
          )}
        </div>
      </div>

      {/* Diff Toggle Bar */}
      <div className="border-t border-[var(--color-term-border)] bg-[var(--color-term-border)]/5 px-4 py-2">
        <button
          onClick={() => setShowDiff(!showDiff)}
          className="text-xs text-zinc-400 hover:text-[var(--color-term-fg)] flex items-center gap-2 hover:underline"
        >
          {showDiff ? '[-] HIDE_DIFF' : '[+] SHOW_DIFF'}
          <span className="text-zinc-600 ml-2">
            (Judge: {event.agentId ?? 'system'})
          </span>
        </button>
      </div>

      {/* Diff Viewer */}
      {showDiff && (
        <div className="border-t border-[var(--color-term-border)] p-4 bg-black">
          <div className="mb-2 text-xs text-zinc-500 flex justify-between">
            <span>SOURCE: {diffData?.source || 'unknown'}</span>
            {diffData?.truncated && <span className="text-yellow-500">[ TRUNCATED ]</span>}
          </div>

          {isDiffLoading ? (
            <div className="text-zinc-500 text-xs animate-pulse">&gt; Fetching diff...</div>
          ) : diffError ? (
            <div className="text-red-500 text-xs">&gt; ERR: {diffErrorMessage}</div>
          ) : (
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap overflow-x-auto">
              {diffData?.diff || '// No diff available'}
            </pre>
          )}
        </div>
      )}
    </section>
  );
};

const getVerdictColor = (verdict: string) => {
  switch (verdict) {
    case 'approve':
      return 'text-[var(--color-term-tiger)]';
    case 'request_changes':
      return 'text-red-500';
    case 'needs_human':
      return 'text-yellow-500';
    default:
      return 'text-zinc-500';
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success':
      return 'text-[var(--color-term-tiger)]';
    case 'failure':
    case 'error':
      return 'text-red-500';
    case 'pending':
      return 'text-yellow-500';
    default:
      return 'text-zinc-500';
  }
};
