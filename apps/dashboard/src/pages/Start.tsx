import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, systemApi, type SystemProcess } from '../lib/api';

const MAX_WORKERS = 4;
const MAX_TESTERS = 2;
const MAX_DOCSERS = 1;

const STATUS_LABELS: Record<SystemProcess['status'], string> = {
  idle: 'IDLE',
  running: 'RUNNING',
  completed: 'DONE',
  failed: 'FAILED',
  stopped: 'STOPPED',
};

const STATUS_COLORS: Record<SystemProcess['status'], string> = {
  idle: 'text-zinc-500',
  running: 'text-[var(--color-term-green)] animate-pulse',
  completed: 'text-zinc-300',
  failed: 'text-red-500',
  stopped: 'text-yellow-500',
};

type StartResult = {
  started: string[];
  errors: string[];
  warnings: string[];
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() !== 'false';
}

function parseCount(
  value: string | undefined,
  fallback: number,
  max: number,
  label: string
): { count: number; warning?: string } {
  const parsed = value ? parseInt(value, 10) : NaN;
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  const clamped = Math.max(0, Math.min(normalized, max));
  if (normalized > max) {
    return { count: clamped, warning: `${label} max limit ${max}` };
  }
  return { count: clamped };
}

const formatTimestamp = (value?: string) => (value ? new Date(value).toLocaleTimeString() : '--:--:--');

export const StartPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [requirementPath, setRequirementPath] = useState('requirement.md');
  const [content, setContent] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [startResult, setStartResult] = useState<StartResult | null>(null);
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoMessage, setRepoMessage] = useState('');

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => configApi.get(),
  });

  const { data: health, isError: isHealthError } = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => systemApi.health(),
    refetchInterval: 30000,
    retry: 1,
  });

  const { data: processes } = useQuery({
    queryKey: ['system', 'processes'],
    queryFn: () => systemApi.processes(),
    refetchInterval: 5000,
  });

  const planner = useMemo(
    () => processes?.find((process) => process.name === 'planner'),
    [processes]
  );

  useEffect(() => {
    if (!config?.config) return;
    if (config.config.REPLAN_REQUIREMENT_PATH && requirementPath === 'requirement.md') {
      setRequirementPath(config.config.REPLAN_REQUIREMENT_PATH);
    }
    if (!repoOwner && config.config.GITHUB_OWNER) {
      setRepoOwner(config.config.GITHUB_OWNER);
    }
    if (!repoName && config.config.GITHUB_REPO) {
      setRepoName(config.config.GITHUB_REPO);
    }
  }, [config?.config, requirementPath, repoName, repoOwner]);

  const loadMutation = useMutation({
    mutationFn: (path: string) => systemApi.requirement(path),
    onSuccess: (data) => {
      setContent(data.content);
      setLoadMessage(`> READ_OK: ${data.path}`);
    },
    onError: (error) => {
      setLoadMessage(error instanceof Error ? `> READ_ERR: ${error.message}` : '> READ_FAIL');
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const settings = config?.config;
      if (!settings) throw new Error('Config not loaded');
      const repoMode = (settings.REPO_MODE ?? 'git').toLowerCase();
      const hasRepoUrl = Boolean(settings.REPO_URL?.trim());
      if (repoMode === 'git' && !hasRepoUrl && (!settings.GITHUB_OWNER || !settings.GITHUB_REPO)) {
        throw new Error('GitHub repo is not configured');
      }
      if (content.trim().length === 0) throw new Error('Requirements empty');

      const dispatcherEnabled = parseBoolean(settings.DISPATCHER_ENABLED, true);
      const judgeEnabled = parseBoolean(settings.JUDGE_ENABLED, true);
      const cycleEnabled = parseBoolean(settings.CYCLE_MANAGER_ENABLED, true);

      const workerCount = parseCount(settings.WORKER_COUNT, 1, MAX_WORKERS, 'Worker');
      const testerCount = parseCount(settings.TESTER_COUNT, 1, MAX_TESTERS, 'Tester');
      const docserCount = parseCount(settings.DOCSER_COUNT, 1, MAX_DOCSERS, 'Docser');

      const warnings = [workerCount.warning, testerCount.warning, docserCount.warning].filter(
        (value): value is string => typeof value === 'string'
      );

      const started: string[] = [];
      const errors: string[] = [];

      const startProcess = async (name: string, payload?: { requirementPath?: string; content?: string }) => {
        try {
          await systemApi.startProcess(name, payload);
          started.push(name);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`${name}: ${message}`);
        }
      };

      await startProcess('planner', { requirementPath, content });

      if (dispatcherEnabled) await startProcess('dispatcher');
      if (judgeEnabled) await startProcess('judge');
      if (cycleEnabled) await startProcess('cycle-manager');

      for (let i = 1; i <= workerCount.count; i += 1) await startProcess(`worker-${i}`);
      for (let i = 1; i <= testerCount.count; i += 1) await startProcess(`tester-${i}`);
      if (docserCount.count > 0) await startProcess('docser-1');

      return { started, errors, warnings };
    },
    onSuccess: (result) => {
      setStartResult(result);
      queryClient.invalidateQueries({ queryKey: ['system', 'processes'] });
    },
    onError: (error) => {
      setStartResult({
        started: [],
        errors: [error instanceof Error ? error.message : 'Launch failed'],
        warnings: [],
      });
    },
  });

  const createRepoMutation = useMutation({
    mutationFn: async () => {
      if (!repoOwner.trim() || !repoName.trim()) {
        throw new Error('Owner and repo are required');
      }
      return systemApi.createGithubRepo({
        owner: repoOwner.trim(),
        repo: repoName.trim(),
        private: true,
      });
    },
    onSuccess: (repo) => {
      setRepoMessage(`> REPO_READY: ${repo.owner}/${repo.name}`);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (error) => {
      setRepoMessage(error instanceof Error ? `> REPO_ERR: ${error.message}` : '> REPO_FAIL');
    },
  });

  const configValues = config?.config ?? {};
  const repoMode = (configValues.REPO_MODE ?? 'git').toLowerCase();
  const isGitMode = repoMode === 'git';
  const hasGithubToken = Boolean(configValues.GITHUB_TOKEN?.trim());
  const repoUrl = configValues.REPO_URL?.trim();
  const isRepoMissing =
    isGitMode && (!repoUrl && (!configValues.GITHUB_OWNER || !configValues.GITHUB_REPO));
  const workerCount = parseCount(configValues.WORKER_COUNT, 1, MAX_WORKERS, 'Worker').count;
  const testerCount = parseCount(configValues.TESTER_COUNT, 1, MAX_TESTERS, 'Tester').count;

  const runningWorkers = processes?.filter(
    (process) => process.name.startsWith('worker-') && process.status === 'running'
  ).length ?? 0;
  const runningTesters = processes?.filter(
    (process) => process.name.startsWith('tester-') && process.status === 'running'
  ).length ?? 0;
  const runningDocser = processes?.find(
    (process) => process.name === 'docser-1' && process.status === 'running'
  );

  const dispatcherStatus = processes?.find((process) => process.name === 'dispatcher')?.status ?? 'idle';
  const judgeStatus = processes?.find((process) => process.name === 'judge')?.status ?? 'idle';
  const cycleStatus = processes?.find((process) => process.name === 'cycle-manager')?.status ?? 'idle';

  const isContentEmpty = content.trim().length === 0;
  const isStartBlocked = isRepoMissing;
  const isHealthy = health?.status === 'ok' && !isHealthError;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 text-[var(--color-term-fg)]">
      <div>
        <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
          &gt; System_Bootstrap
        </h1>
        <p className="text-xs text-zinc-500 mt-1 font-mono">
          // Initialize planner from requirements.md and spawn subprocesses.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* System Status Panel */}
        <section className="border border-[var(--color-term-border)] p-0 h-full">
          <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex justify-between items-center">
            <h2 className="text-sm font-bold uppercase tracking-wider">Status_Monitor</h2>
            <span className="text-xs text-zinc-500">{isHealthy ? '[API: ONLINE]' : '[API: OFFLINE]'}</span>
          </div>

          <div className="p-4 space-y-4 font-mono text-sm">
            <div className="grid grid-cols-2 gap-y-2">
              <div className="text-zinc-500">Dispatcher</div>
              <div className={STATUS_COLORS[dispatcherStatus]}>{STATUS_LABELS[dispatcherStatus]}</div>

              <div className="text-zinc-500">Judge</div>
              <div className={STATUS_COLORS[judgeStatus]}>{STATUS_LABELS[judgeStatus]}</div>

              <div className="text-zinc-500">CycleManager</div>
              <div className={STATUS_COLORS[cycleStatus]}>{STATUS_LABELS[cycleStatus]}</div>
            </div>

            <div className="border-t border-[var(--color-term-border)] pt-4 mt-2">
              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Active Workers</span>
                <span>{runningWorkers} / {workerCount}</span>
              </div>
              <div className="w-full bg-zinc-900 h-1 mb-3">
                <div className="h-full bg-[var(--color-term-green)]" style={{ width: `${(runningWorkers / workerCount) * 100}%` }}></div>
              </div>

              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Active Testers</span>
                <span>{runningTesters} / {testerCount}</span>
              </div>
              <div className="w-full bg-zinc-900 h-1 mb-3">
                <div className="h-full bg-[var(--color-term-green)]" style={{ width: `${(runningTesters / testerCount) * 100}%` }}></div>
              </div>

              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Docs</span>
                <span>{runningDocser ? 'ONLINE' : 'OFFLINE'}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Start Control Panel */}
        <section className="border border-[var(--color-term-border)] p-0 h-full flex flex-col">
          <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
            <h2 className="text-sm font-bold uppercase tracking-wider">Boot_Sequence</h2>
          </div>

          <div className="p-4 flex-1 flex flex-col gap-4">
            {isRepoMissing && (
              <div className="border border-[var(--color-term-border)] p-3 text-xs font-mono space-y-2">
                <div className="text-zinc-400">GitHub Repo Setup (git mode)</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 bg-black border border-[var(--color-term-border)] px-3 py-1 text-xs text-[var(--color-term-fg)] focus:border-[var(--color-term-green)] focus:outline-none placeholder-zinc-700"
                    value={repoOwner}
                    onChange={(event) => setRepoOwner(event.target.value)}
                    placeholder="GitHub owner"
                  />
                  <input
                    type="text"
                    className="flex-1 bg-black border border-[var(--color-term-border)] px-3 py-1 text-xs text-[var(--color-term-fg)] focus:border-[var(--color-term-green)] focus:outline-none placeholder-zinc-700"
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    placeholder="Repository name"
                  />
                  <button
                    onClick={() => createRepoMutation.mutate()}
                    disabled={!hasGithubToken || createRepoMutation.isPending}
                    className="border border-[var(--color-term-border)] hover:bg-[var(--color-term-fg)] hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
                  >
                    [ CREATE ]
                  </button>
                </div>
                {!hasGithubToken && (
                  <div className="text-yellow-500">GitHub token is missing in System config</div>
                )}
                {repoMessage && <div className="text-[10px] text-zinc-500 font-mono">{repoMessage}</div>}
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-zinc-500 uppercase">Input Source</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 bg-black border border-[var(--color-term-border)] px-3 py-1 text-sm text-[var(--color-term-fg)] focus:border-[var(--color-term-green)] focus:outline-none placeholder-zinc-700"
                  value={requirementPath}
                  onChange={(event) => setRequirementPath(event.target.value)}
                  placeholder="path/to/requirement.md"
                />
                <button
                  onClick={() => loadMutation.mutate(requirementPath)}
                  disabled={loadMutation.isPending}
                  className="border border-[var(--color-term-border)] hover:bg-[var(--color-term-fg)] hover:text-black px-3 py-1 text-sm uppercase transition-colors disabled:opacity-50"
                >
                  [ LOAD ]
                </button>
              </div>
              {loadMessage && <div className="text-[10px] text-zinc-500 font-mono mt-1">{loadMessage}</div>}
            </div>

            <textarea
              className="flex-1 bg-black border border-[var(--color-term-border)] p-3 text-xs font-mono text-zinc-300 focus:border-[var(--color-term-green)] focus:outline-none resize-none min-h-[150px]"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="> Waiting for content..."
            />

            <div className="flex justify-between items-center pt-2">
              <span className="text-xs text-zinc-600">
                {content.length} bytes loaded
              </span>
              <button
                onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending || isContentEmpty || isStartBlocked}
                className="bg-[var(--color-term-green)] text-black px-6 py-2 text-sm font-bold uppercase hover:opacity-90 disabled:opacity-50 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {startMutation.isPending ? '> INITIATING...' : '> EXECUTE RUN'}
              </button>
            </div>

            {/* Result Console */}
            {(startResult || isContentEmpty || isStartBlocked) && (
              <div className="border-t border-[var(--color-term-border)] mt-2 pt-2 gap-1 flex flex-col text-xs font-mono">
                {isContentEmpty && <div className="text-yellow-500">&gt; WARN: Content empty</div>}
                {isStartBlocked && <div className="text-yellow-500">&gt; WARN: GitHub repo is missing</div>}
                {startResult?.warnings.map(w => <div key={w} className="text-yellow-500">&gt; WARN: {w}</div>)}
                {startResult?.errors.map(e => <div key={e} className="text-red-500">&gt; ERR: {e}</div>)}
                {startResult?.started.length && <div className="text-[var(--color-term-green)]">&gt; BOOT SEQ INITIATED</div>}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Legacy Planner Logs */}
      <section className="border border-[var(--color-term-border)] p-0">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">Planner_Output</h2>
          <span className={`text-xs uppercase ${STATUS_COLORS[planner?.status ?? 'idle']}`}>
            [{STATUS_LABELS[planner?.status ?? 'idle']}]
          </span>
        </div>
        <div className="p-4 font-mono text-xs space-y-1">
          <div className="flex gap-4">
            <span className="text-zinc-500 w-24">STARTED</span>
            <span>{formatTimestamp(planner?.startedAt)}</span>
          </div>
          <div className="flex gap-4">
            <span className="text-zinc-500 w-24">FINISHED</span>
            <span>{formatTimestamp(planner?.finishedAt)}</span>
          </div>
          <div className="flex gap-4">
            <span className="text-zinc-500 w-24">LOG_PATH</span>
            <span className="text-zinc-400">{planner?.logPath || '--'}</span>
          </div>
          {planner?.message && planner.status === 'failed' && (
            <div className="text-red-500 mt-2 border-l-2 border-red-500 pl-2">
              &gt; CRITICAL_ERR: {planner.message}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

