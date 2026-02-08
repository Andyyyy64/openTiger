import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { logsApi } from '../lib/api';

const DEFAULT_CYCLE_LINES = 200;
const DEFAULT_ALL_LIMIT = 1000;
const DEFAULT_SINCE_MINUTES = 30;

export const LogsPage: React.FC = () => {
  const [cycleLinesInput, setCycleLinesInput] = useState(String(DEFAULT_CYCLE_LINES));
  const [allLimitInput, setAllLimitInput] = useState(String(DEFAULT_ALL_LIMIT));
  const [sinceMinutesInput, setSinceMinutesInput] = useState(String(DEFAULT_SINCE_MINUTES));
  const [sourceFilterInput, setSourceFilterInput] = useState('');

  const cycleLogRef = useRef<HTMLDivElement>(null);
  const allLogsRef = useRef<HTMLDivElement>(null);

  const cycleLines = useMemo(() => {
    const parsed = Number.parseInt(cycleLinesInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CYCLE_LINES;
  }, [cycleLinesInput]);

  const allLimit = useMemo(() => {
    const parsed = Number.parseInt(allLimitInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALL_LIMIT;
  }, [allLimitInput]);

  const sinceMinutes = useMemo(() => {
    if (!sinceMinutesInput.trim()) {
      return undefined;
    }
    const parsed = Number.parseInt(sinceMinutesInput, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SINCE_MINUTES;
  }, [sinceMinutesInput]);

  const sourceFilter = sourceFilterInput.trim() || undefined;

  const {
    data: cycleLog,
    isLoading: isCycleLoading,
    error: cycleError,
  } = useQuery({
    queryKey: ['logs', 'cycle-manager', cycleLines],
    queryFn: () => logsApi.cycleManager(cycleLines),
    refetchInterval: 10000,
  });

  const {
    data: allLogs,
    isLoading: isAllLoading,
    error: allError,
  } = useQuery({
    queryKey: ['logs', 'all', allLimit, sinceMinutes ?? 'all', sourceFilter ?? ''],
    queryFn: () => logsApi.all({ limit: allLimit, sinceMinutes, source: sourceFilter }),
    refetchInterval: 10000,
  });

  // ログが更新されたときに一番下までスクロールする
  useEffect(() => {
    if (cycleLogRef.current) {
      cycleLogRef.current.scrollTop = cycleLogRef.current.scrollHeight;
    }
  }, [cycleLog]);

  useEffect(() => {
    if (allLogsRef.current) {
      allLogsRef.current.scrollTop = allLogsRef.current.scrollHeight;
    }
  }, [allLogs]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6 text-[var(--color-term-fg)]">
      <section className="border border-[var(--color-term-border)] p-0">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
          <h1 className="text-lg font-bold uppercase tracking-wider text-[var(--color-term-tiger)] font-pixel">
            &gt; Logs_Console
          </h1>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 p-4 border-b border-[var(--color-term-border)]">
          <label className="text-xs uppercase text-zinc-500">
            cycle lines
            <input
              value={cycleLinesInput}
              onChange={(e) => setCycleLinesInput(e.target.value)}
              className="mt-1 w-full bg-black border border-[var(--color-term-border)] px-2 py-1 text-zinc-200"
            />
          </label>

          <label className="text-xs uppercase text-zinc-500">
            all limit
            <input
              value={allLimitInput}
              onChange={(e) => setAllLimitInput(e.target.value)}
              className="mt-1 w-full bg-black border border-[var(--color-term-border)] px-2 py-1 text-zinc-200"
            />
          </label>

          <label className="text-xs uppercase text-zinc-500">
            since minutes
            <input
              value={sinceMinutesInput}
              onChange={(e) => setSinceMinutesInput(e.target.value)}
              placeholder="empty = all"
              className="mt-1 w-full bg-black border border-[var(--color-term-border)] px-2 py-1 text-zinc-200"
            />
          </label>

          <label className="text-xs uppercase text-zinc-500">
            source filter
            <input
              value={sourceFilterInput}
              onChange={(e) => setSourceFilterInput(e.target.value)}
              placeholder="worker-1 / tasks/"
              className="mt-1 w-full bg-black border border-[var(--color-term-border)] px-2 py-1 text-zinc-200"
            />
          </label>
        </div>
      </section>

      <section className="border border-[var(--color-term-border)] p-0">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            cycle-manager.log (tail -n {cycleLines})
          </span>
          <span className="text-[10px] text-zinc-600 font-mono">
            {cycleLog?.updatedAt ? `UPDATED: ${new Date(cycleLog.updatedAt).toLocaleTimeString()}` : ''}
          </span>
        </div>
        <div
          ref={cycleLogRef}
          className="h-56 overflow-y-auto bg-black p-3 font-mono text-xs whitespace-pre-wrap text-zinc-300"
        >
          {isCycleLoading && <div className="text-zinc-500 animate-pulse">&gt; Loading cycle-manager log...</div>}
          {!isCycleLoading && cycleError && <div className="text-red-500">&gt; Failed to read cycle-manager log</div>}
          {!isCycleLoading && !cycleError && cycleLog?.log}
        </div>
      </section>

      <section className="border border-[var(--color-term-border)] p-0">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            all logs (time ordered)
          </span>
          <span className="text-[10px] text-zinc-600 font-mono">
            {allLogs
              ? `SOURCES: ${allLogs.sourceCount} | RETURNED: ${allLogs.returned}/${allLogs.total}${allLogs.truncated ? ' (truncated)' : ''}`
              : ''}
          </span>
        </div>
        <div
          ref={allLogsRef}
          className="h-[560px] overflow-y-auto bg-black p-3 font-mono text-xs text-zinc-300"
        >
          {isAllLoading && <div className="text-zinc-500 animate-pulse">&gt; Aggregating logs...</div>}
          {!isAllLoading && allError && <div className="text-red-500">&gt; Failed to read aggregated logs</div>}
          {!isAllLoading && !allError && allLogs?.entries.length === 0 && (
            <div className="text-zinc-600">&gt; No log entries found for current filter.</div>
          )}
          {!isAllLoading && !allError && allLogs?.entries.map((entry, index) => (
            <div key={`${entry.source}:${entry.lineNo}:${index}`} className="whitespace-pre-wrap">
              <span className="text-zinc-500">
                [{entry.explicitTimestamp ? entry.timestamp : `~${entry.timestamp}`}]
              </span>{' '}
              <span className="text-blue-300">{entry.source}:{entry.lineNo}</span>{' '}
              <span>|</span>{' '}
              <span>{entry.line}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
