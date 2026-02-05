import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, systemApi } from '../lib/api';
import { RotateCw, Save, Trash2 } from 'lucide-react';

type SettingField = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'text' | 'number' | 'boolean';
};

const SETTINGS: SettingField[] = [
  {
    key: 'MAX_CONCURRENT_WORKERS',
    label: '並列Worker数',
    description: '最大同時実行数',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DAILY_TOKEN_LIMIT',
    label: '日次トークン上限',
    description: '1日あたりのトークン上限',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'HOURLY_TOKEN_LIMIT',
    label: '時間トークン上限',
    description: '1時間あたりのトークン上限',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'TASK_TOKEN_LIMIT',
    label: 'タスクトークン上限',
    description: 'タスク単位のトークン上限',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DISPATCHER_ENABLED',
    label: 'Dispatcher有効',
    description: '起動対象に含める',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'JUDGE_ENABLED',
    label: 'Judge有効',
    description: '起動対象に含める',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'CYCLE_MANAGER_ENABLED',
    label: 'Cycle Manager有効',
    description: '起動対象に含める',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'WORKER_COUNT',
    label: 'Worker台数',
    description: '起動するWorkerの台数',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'TESTER_COUNT',
    label: 'Tester台数',
    description: '起動するTesterの台数',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'DOCSER_COUNT',
    label: 'Docser台数',
    description: '起動するDocserの台数',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'REPO_MODE',
    label: 'Repoモード',
    description: 'git/localの切り替え',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'LOCAL_REPO_PATH',
    label: 'Local Repo Path',
    description: 'localモードのベースリポジトリ',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'LOCAL_WORKTREE_ROOT',
    label: 'Worktree Root',
    description: 'worktreeの作成先',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'JUDGE_MODE',
    label: 'Judgeモード',
    description: 'git/local/autoの切り替え',
    group: 'Judge',
    type: 'text',
  },
  {
    key: 'LOCAL_POLICY_MAX_LINES',
    label: 'ローカル行数上限',
    description: 'local判定の最大変更行数',
    group: 'Judge',
    type: 'number',
  },
  {
    key: 'LOCAL_POLICY_MAX_FILES',
    label: 'ローカルファイル上限',
    description: 'local判定の最大変更ファイル数',
    group: 'Judge',
    type: 'number',
  },
  {
    key: 'BASE_BRANCH',
    label: 'ベースブランチ',
    description: '判定/再計画で利用する基準ブランチ',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'OPENCODE_MODEL',
    label: 'OpenCodeモデル',
    description: '共通のOpenCode実行モデル',
    group: 'Models',
    type: 'text',
  },
  {
    key: 'PLANNER_MODEL',
    label: 'Plannerモデル',
    description: 'Plannerが利用するモデル',
    group: 'Models',
    type: 'text',
  },
  {
    key: 'JUDGE_MODEL',
    label: 'Judgeモデル',
    description: 'Judgeが利用するモデル',
    group: 'Models',
    type: 'text',
  },
  {
    key: 'WORKER_MODEL',
    label: 'Workerモデル',
    description: 'Workerが利用するモデル',
    group: 'Models',
    type: 'text',
  },
  {
    key: 'PLANNER_USE_REMOTE',
    label: 'Plannerリモート利用',
    description: 'Plannerがリモートリポジトリを使うか',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'PLANNER_REPO_URL',
    label: 'Planner Repo URL',
    description: 'Plannerが参照するリポジトリURL',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'AUTO_REPLAN',
    label: '自動再計画',
    description: 'タスク枯渇時の再計画を有効化',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'REPLAN_REQUIREMENT_PATH',
    label: '要件パス',
    description: '再計画に使うrequirement.md',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_INTERVAL_MS',
    label: '再計画間隔(ms)',
    description: '再計画の最小間隔',
    group: 'Planner',
    type: 'number',
  },
  {
    key: 'REPLAN_COMMAND',
    label: '再計画コマンド',
    description: 'Planner実行コマンド',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_WORKDIR',
    label: '再計画作業ディレクトリ',
    description: 'Planner実行ディレクトリ',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_REPO_URL',
    label: '再計画Repo URL',
    description: '差分判定に使うリポジトリURL',
    group: 'Planner',
    type: 'text',
  },
];

export const SettingsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: () => configApi.get(),
  });
  const restartQuery = useQuery({
    queryKey: ['system-restart'],
    queryFn: () => systemApi.restartStatus(),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false),
  });

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    // APIの取得結果をフォームへ同期する
    if (data?.config) {
      setValues(data.config);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  const restartMutation = useMutation({
    mutationFn: () => systemApi.restart(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-restart'] });
    },
  });
  const cleanupMutation = useMutation({
    mutationFn: () => systemApi.cleanup(),
  });
  const isCleanupSuccess = cleanupMutation.isSuccess;
  const resetCleanup = cleanupMutation.reset;

  const grouped = useMemo(() => {
    const entries = new Map<string, SettingField[]>();
    for (const field of SETTINGS) {
      if (!entries.has(field.group)) {
        entries.set(field.group, []);
      }
      entries.get(field.group)?.push(field);
    }
    return Array.from(entries.entries());
  }, []);

  const handleSave = () => {
    mutation.mutate(values);
  };

  const updateValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const restartStatus = restartQuery.data?.status ?? 'idle';
  const restartStatusLabel =
    restartStatus === 'running'
      ? '実行中'
      : restartStatus === 'completed'
        ? '完了'
        : restartStatus === 'failed'
          ? '失敗'
          : '未実行';
  const restartButtonLabel =
    restartMutation.isPending || restartStatus === 'running' ? '再起動中...' : '再起動する';
  const formatTimestamp = (value?: string) => (value ? new Date(value).toLocaleString() : '');
  useEffect(() => {
    // 初期化の成功表示は一定時間で消す
    if (!isCleanupSuccess) return;
    const timer = window.setTimeout(() => {
      resetCleanup();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isCleanupSuccess, resetCleanup]);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">System</h1>
          <p className="text-sm text-slate-400 mt-2">
            設定はDBに保存されます。起動済みのプロセスには次回のStartから反映されます。
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={mutation.isPending}
          className="bg-yellow-500 hover:bg-yellow-600 disabled:opacity-60 text-slate-950 px-4 py-2 rounded-lg font-bold flex items-center gap-2"
        >
          <Save size={18} />
          {mutation.isPending ? '保存中...' : '保存'}
        </button>
      </div>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">System</h2>
            <p className="text-xs text-slate-500">
              現在の設定を反映するために、バックエンドの再起動を実行します。
            </p>
          </div>
          <button
            onClick={() => restartMutation.mutate()}
            disabled={restartMutation.isPending || restartStatus === 'running'}
            className="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-100 px-4 py-2 rounded-lg font-semibold flex items-center gap-2"
          >
            <RotateCw
              size={18}
              className={restartMutation.isPending || restartStatus === 'running' ? 'animate-spin' : ''}
            />
            {restartButtonLabel}
          </button>
        </div>
        <div className="text-sm text-slate-400">
          ステータス: {restartStatusLabel}
        </div>
        {(restartQuery.data?.startedAt || restartQuery.data?.finishedAt) && (
          <div className="text-xs text-slate-500">
            開始: {formatTimestamp(restartQuery.data?.startedAt)} / 完了: {formatTimestamp(restartQuery.data?.finishedAt)}
          </div>
        )}
        {restartQuery.data?.logPath && (
          <div className="text-xs text-slate-500">ログ: {restartQuery.data.logPath}</div>
        )}
        {restartQuery.data?.message && restartStatus === 'failed' && (
          <div className="text-xs text-red-400">エラー: {restartQuery.data.message}</div>
        )}
        {restartQuery.isError && (
          <div className="text-xs text-red-400">
            再起動ステータスの取得に失敗しました。
          </div>
        )}
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">DB Cleanup</h2>
            <p className="text-xs text-slate-500">
              plan/task/run/eventなどの状態を初期化します。
            </p>
          </div>
          <button
            onClick={() => cleanupMutation.mutate()}
            disabled={cleanupMutation.isPending}
            className="bg-red-500 hover:bg-red-600 disabled:opacity-60 text-slate-950 px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2"
          >
            <Trash2 size={16} />
            初期化
          </button>
        </div>
        {cleanupMutation.isError && (
          <div className="text-xs text-red-400">
            {cleanupMutation.error instanceof Error
              ? cleanupMutation.error.message
              : 'クリーンアップに失敗しました。'}
          </div>
        )}
        {cleanupMutation.isSuccess && (
          <div className="text-xs text-emerald-400">DBを初期化しました。</div>
        )}
      </section>

      {isLoading && <div className="text-center text-slate-500">Loading settings...</div>}
      {error && <div className="text-center text-red-400">Error loading settings</div>}

      <div className="space-y-8">
        {grouped.map(([group, fields]) => (
          <section key={group} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">{group}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fields.map((field) => (
                <div key={field.key} className="space-y-2">
                  <div className="text-sm text-slate-300">{field.label}</div>
                  <div className="text-xs text-slate-500">{field.description}</div>
                  {field.type === 'boolean' ? (
                    <select
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
                      value={(values[field.key] ?? '').toLowerCase() === 'true' ? 'true' : 'false'}
                      onChange={(e) => updateValue(field.key, e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
                      value={values[field.key] ?? ''}
                      onChange={(e) => updateValue(field.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
