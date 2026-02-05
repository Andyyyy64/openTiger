import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, systemApi, type SystemProcess } from '../lib/api';
import { Play, Download, FileText, Activity } from 'lucide-react';

const MAX_WORKERS = 4;
const MAX_TESTERS = 2;
const MAX_DOCSERS = 1;

const STATUS_LABELS: Record<SystemProcess['status'], string> = {
  idle: '待機中',
  running: '実行中',
  completed: '完了',
  failed: '失敗',
  stopped: '停止',
};

const STATUS_COLORS: Record<SystemProcess['status'], string> = {
  idle: 'text-slate-500',
  running: 'text-emerald-400',
  completed: 'text-slate-300',
  failed: 'text-red-400',
  stopped: 'text-amber-400',
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
    return { count: clamped, warning: `${label}は最大${max}台までです。` };
  }
  return { count: clamped };
}

const formatTimestamp = (value?: string) => (value ? new Date(value).toLocaleString() : '');

export const StartPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [requirementPath, setRequirementPath] = useState('requirement.md');
  const [content, setContent] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [startResult, setStartResult] = useState<StartResult | null>(null);

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
    // 設定済みの要件パスを初期値として採用する
    if (!config?.config) return;
    if (config.config.REPLAN_REQUIREMENT_PATH && requirementPath === 'requirement.md') {
      setRequirementPath(config.config.REPLAN_REQUIREMENT_PATH);
    }
  }, [config?.config, requirementPath]);

  const loadMutation = useMutation({
    mutationFn: (path: string) => systemApi.requirement(path),
    onSuccess: (data) => {
      setContent(data.content);
      setLoadMessage(`読み込み完了: ${data.path}`);
    },
    onError: (error) => {
      setLoadMessage(error instanceof Error ? error.message : '読み込みに失敗しました。');
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const settings = config?.config;
      if (!settings) {
        throw new Error('設定を読み込んでから実行してください。');
      }
      if (content.trim().length === 0) {
        throw new Error('requirementsの内容が空です。');
      }

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
          const message = error instanceof Error ? error.message : '起動に失敗しました。';
          errors.push(`${name}: ${message}`);
        }
      };

      await startProcess('planner', { requirementPath, content });

      if (dispatcherEnabled) {
        await startProcess('dispatcher');
      }
      if (judgeEnabled) {
        await startProcess('judge');
      }
      if (cycleEnabled) {
        await startProcess('cycle-manager');
      }

      for (let i = 1; i <= workerCount.count; i += 1) {
        await startProcess(`worker-${i}`);
      }
      for (let i = 1; i <= testerCount.count; i += 1) {
        await startProcess(`tester-${i}`);
      }
      if (docserCount.count > 0) {
        await startProcess('docser-1');
      }

      return { started, errors, warnings };
    },
    onSuccess: (result) => {
      setStartResult(result);
      queryClient.invalidateQueries({ queryKey: ['system', 'processes'] });
    },
    onError: (error) => {
      setStartResult({
        started: [],
        errors: [error instanceof Error ? error.message : '起動に失敗しました。'],
        warnings: [],
      });
    },
  });

  const configValues = config?.config ?? {};
  const workerCount = parseCount(configValues.WORKER_COUNT, 1, MAX_WORKERS, 'Worker').count;
  const testerCount = parseCount(configValues.TESTER_COUNT, 1, MAX_TESTERS, 'Tester').count;
  const docserCount = parseCount(configValues.DOCSER_COUNT, 1, MAX_DOCSERS, 'Docser').count;

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
  const isHealthy = health?.status === 'ok' && !isHealthError;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Start</h1>
        <p className="text-sm text-slate-400 mt-2">
          requirements.md を起点にPlannerを実行し、設定済みの構成で起動します。
        </p>
      </div>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Activity size={16} />
          システム状態
        </div>
        <div className="text-sm text-slate-400">
          API: {isHealthy ? 'Healthy' : 'Disconnected'}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-slate-400">
          <div>
            Dispatcher: <span className={STATUS_COLORS[dispatcherStatus]}>{STATUS_LABELS[dispatcherStatus]}</span>
          </div>
          <div>
            Judge: <span className={STATUS_COLORS[judgeStatus]}>{STATUS_LABELS[judgeStatus]}</span>
          </div>
          <div>
            Cycle Manager: <span className={STATUS_COLORS[cycleStatus]}>{STATUS_LABELS[cycleStatus]}</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-slate-400">
          <div>Worker: {runningWorkers} / 設定 {workerCount}</div>
          <div>Tester: {runningTesters} / 設定 {testerCount}</div>
          <div>Docser: {runningDocser ? 1 : 0} / 設定 {docserCount}</div>
        </div>
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm text-slate-300">requirementsパス</label>
          <div className="flex flex-col md:flex-row gap-3">
            <input
              type="text"
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
              value={requirementPath}
              onChange={(event) => setRequirementPath(event.target.value)}
              placeholder="requirement.md"
            />
            <button
              onClick={() => loadMutation.mutate(requirementPath)}
              disabled={loadMutation.isPending}
              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-100 px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2"
            >
              <Download size={16} />
              読み込み
            </button>
          </div>
          {loadMessage && <div className="text-xs text-slate-500">{loadMessage}</div>}
        </div>

        <div className="flex items-center justify-between">
          <label className="text-sm text-slate-300 flex items-center gap-2">
            <FileText size={16} />
            requirement内容
          </label>
          <button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending || isContentEmpty}
            className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-slate-950 px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2"
          >
            <Play size={16} />
            起動
          </button>
        </div>
        <textarea
          className="w-full min-h-[360px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="要件を入力してください"
        />
        {isContentEmpty && (
          <div className="text-xs text-amber-400">内容が空のため実行できません。</div>
        )}
        {startResult && (
          <div className="space-y-2 text-xs">
            {startResult.warnings.length > 0 && (
              <div className="text-amber-400">
                {startResult.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            )}
            {startResult.errors.length > 0 && (
              <div className="text-red-400">
                {startResult.errors.map((error) => (
                  <div key={error}>{error}</div>
                ))}
              </div>
            )}
            {startResult.errors.length === 0 && startResult.started.length > 0 && (
              <div className="text-emerald-400">起動リクエストを送信しました。</div>
            )}
          </div>
        )}
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-3">
        <h2 className="text-lg font-semibold">Planner状態</h2>
        <div className="text-sm text-slate-400">
          ステータス:{' '}
          <span className={STATUS_COLORS[planner?.status ?? 'idle']}>
            {STATUS_LABELS[planner?.status ?? 'idle']}
          </span>
        </div>
        {(planner?.startedAt || planner?.finishedAt) && (
          <div className="text-xs text-slate-500">
            開始: {formatTimestamp(planner?.startedAt)} / 完了: {formatTimestamp(planner?.finishedAt)}
          </div>
        )}
        {planner?.logPath && (
          <div className="text-xs text-slate-500">ログ: {planner.logPath}</div>
        )}
        {planner?.message && planner.status === 'failed' && (
          <div className="text-xs text-red-400">エラー: {planner.message}</div>
        )}
      </section>
    </div>
  );
};
