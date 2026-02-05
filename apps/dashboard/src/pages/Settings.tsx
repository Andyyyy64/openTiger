import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, systemApi } from '../lib/api';

// ========================================
// Option Constants for Select Fields
// ========================================

const REPO_MODE_OPTIONS = ['git', 'local'] as const;
const JUDGE_MODE_OPTIONS = ['git', 'local', 'auto'] as const;

// Supported OpenCode models (provider/model format)
// Reference: https://opencode.ai/docs/providers
const MODEL_OPTIONS = [
  // Anthropic
  'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-opus-4-20250514',
  'anthropic/claude-3.5-sonnet',
  // Google
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro-preview-05-06',
  'google/gemini-2.5-flash-preview-04-17',
  // OpenAI
  'openai/gpt-5.1',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/o3',
  'openai/o4-mini',
  // xAI
  'xai/grok-3',
  'xai/grok-3-mini',
  // DeepSeek
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
] as const;

type SettingField = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: readonly string[];
};

const SETTINGS: SettingField[] = [
  {
    key: 'MAX_CONCURRENT_WORKERS',
    label: 'Parallel_Workers',
    description: 'Max concurrent worker processes',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DAILY_TOKEN_LIMIT',
    label: 'Daily_Token_Max',
    description: 'Max tokens per day',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'HOURLY_TOKEN_LIMIT',
    label: 'Hourly_Token_Max',
    description: 'Max tokens per hour',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'TASK_TOKEN_LIMIT',
    label: 'Task_Token_Max',
    description: 'Max tokens per single task',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DISPATCHER_ENABLED',
    label: 'Enable_Dispatcher',
    description: 'Include dispatcher in boot sequence',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'JUDGE_ENABLED',
    label: 'Enable_Judge',
    description: 'Include judge in boot sequence',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'CYCLE_MANAGER_ENABLED',
    label: 'Enable_CycleMgr',
    description: 'Include cycle manager',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'WORKER_COUNT',
    label: 'Worker_Count',
    description: 'Number of worker nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'TESTER_COUNT',
    label: 'Tester_Count',
    description: 'Number of tester nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'DOCSER_COUNT',
    label: 'Docser_Count',
    description: 'Number of docser nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'REPO_MODE',
    label: 'Repo_Mode',
    description: 'git or local mode',
    group: 'Repo',
    type: 'select',
    options: REPO_MODE_OPTIONS,
  },
  {
    key: 'LOCAL_REPO_PATH',
    label: 'Local_Repo_Path',
    description: 'Path for local mode',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'LOCAL_WORKTREE_ROOT',
    label: 'Worktree_Root',
    description: 'Destination for worktrees',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'JUDGE_MODE',
    label: 'Judge_Mode',
    description: 'git/local/auto switch',
    group: 'Judge',
    type: 'select',
    options: JUDGE_MODE_OPTIONS,
  },
  {
    key: 'LOCAL_POLICY_MAX_LINES',
    label: 'Local_Policy_MaxLines',
    description: 'Max lines for local check',
    group: 'Judge',
    type: 'number',
  },
  {
    key: 'LOCAL_POLICY_MAX_FILES',
    label: 'Local_Policy_MaxFiles',
    description: 'Max files for local check',
    group: 'Judge',
    type: 'number',
  },
  {
    key: 'BASE_BRANCH',
    label: 'Base_Branch',
    description: 'Target branch (main/master)',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'OPENCODE_MODEL',
    label: 'OpenCode_Model',
    description: 'Default LLM model',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'PLANNER_MODEL',
    label: 'Planner_Model',
    description: 'Model for planner',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'JUDGE_MODEL',
    label: 'Judge_Model',
    description: 'Model for judge',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'WORKER_MODEL',
    label: 'Worker_Model',
    description: 'Model for workers',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'PLANNER_USE_REMOTE',
    label: 'Planner_Use_Remote',
    description: 'Planner uses remote repo',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'PLANNER_REPO_URL',
    label: 'Planner_Repo_URL',
    description: 'Remote repo URL for planner',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'AUTO_REPLAN',
    label: 'Auto_Replan',
    description: 'Enable automatic replanning',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'REPLAN_REQUIREMENT_PATH',
    label: 'Replan_Req_Path',
    description: 'Path for replan requirements',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_INTERVAL_MS',
    label: 'Replan_Interval',
    description: 'MS between replans',
    group: 'Planner',
    type: 'number',
  },
  {
    key: 'REPLAN_COMMAND',
    label: 'Replan_Command',
    description: 'Command to exec planner',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_WORKDIR',
    label: 'Replan_Workdir',
    description: 'Workdir for replan cmd',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_REPO_URL',
    label: 'Replan_Repo_URL',
    description: 'Diff comparison repo',
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
  const restartStatusLabel = restartStatus.toUpperCase();

  const formatTimestamp = (value?: string) => (value ? new Date(value).toLocaleTimeString() : '--:--:--');
  useEffect(() => {
    if (!isCleanupSuccess) return;
    const timer = window.setTimeout(() => {
      resetCleanup();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isCleanupSuccess, resetCleanup]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-[var(--color-term-fg)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
            &gt; System_Configuration
          </h1>
          <p className="text-xs text-zinc-500 mt-1 font-mono">
             // Changes saved to DB. Restart required for active processes.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={mutation.isPending}
          className="border border-[var(--color-term-green)] text-[var(--color-term-green)] hover:bg-[var(--color-term-green)] hover:text-black px-4 py-2 text-sm font-bold uppercase transition-colors disabled:opacity-50"
        >
          {mutation.isPending ? '[ SAVING... ]' : '[ SAVE_CONFIG ]'}
        </button>
      </div>

      {/* System Control Panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="border border-[var(--color-term-border)] p-0">
          <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider">System_Restart</h2>
            <span className="text-xs text-zinc-500">sudo reboot</span>
          </div>
          <div className="p-4 space-y-3 font-mono text-sm">
            <div className="flex justify-between items-center">
              <span className="text-zinc-500">CURRENT_STATUS</span>
              <span className={restartStatus === 'running' ? 'text-[var(--color-term-green)] animate-pulse' : 'text-zinc-300'}>
                [{restartStatusLabel}]
              </span>
            </div>

            <div className="text-xs text-zinc-600 border-l border-zinc-800 pl-2">
              <div>STARTED: {formatTimestamp(restartQuery.data?.startedAt)}</div>
              <div>FINISHED: {formatTimestamp(restartQuery.data?.finishedAt)}</div>
            </div>

            <button
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending || restartStatus === 'running'}
              className="w-full border border-[var(--color-term-border)] hover:bg-[var(--color-term-fg)] hover:text-black py-2 mt-2 text-xs uppercase transition-colors disabled:opacity-50"
            >
              {restartMutation.isPending || restartStatus === 'running' ? '> REBOOTING...' : '> EXECUTE REBOOT'}
            </button>

            {restartQuery.data?.message && restartStatus === 'failed' && (
              <div className="text-red-500 text-xs mt-2">&gt; ERR: {restartQuery.data.message}</div>
            )}
          </div>
        </section>

        <section className="border border-[var(--color-term-border)] p-0">
          <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider">DB_Maintenance</h2>
            <span className="text-xs text-zinc-500">rm -rf /var/db/*</span>
          </div>
          <div className="p-4 space-y-3 font-mono text-sm">
            <div className="text-zinc-500 text-xs mb-2">
                // Purges all runtime data (plans, tasks, runs, events).
              <br />// Use with caution.
            </div>

            <button
              onClick={() => cleanupMutation.mutate()}
              disabled={cleanupMutation.isPending}
              className="w-full border border-red-900 text-red-500 hover:bg-red-900 hover:text-white py-2 text-xs uppercase transition-colors disabled:opacity-50"
            >
              {cleanupMutation.isPending ? '> PURGING...' : '> PURGE DATABASE'}
            </button>

            {cleanupMutation.isSuccess && (
              <div className="text-[var(--color-term-green)] text-xs mt-2">&gt; SUCCESS: Database purged.</div>
            )}
          </div>
        </section>
      </div>

      {isLoading && <div className="text-center text-zinc-500 monitor-scan">&gt; Scanning configuration...</div>}
      {error && <div className="text-center text-red-500">&gt; CONFIG LOAD ERROR</div>}

      <div className="space-y-6">
        {grouped.map(([group, fields]) => (
          <section key={group} className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Config_Section: [{group}]</h2>
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
              {fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <div className="flex justify-between items-baseline mb-1">
                    <label className="text-xs text-[var(--color-term-green)] font-mono">{field.label}</label>
                    <span className="text-[10px] text-zinc-600 uppercase">{field.type}</span>
                  </div>

                  {field.type === 'boolean' ? (
                    <select
                      className="w-full bg-black border border-[var(--color-term-border)] text-sm text-[var(--color-term-fg)] px-2 py-1 font-mono focus:border-[var(--color-term-green)] focus:outline-none"
                      value={(values[field.key] ?? '').toLowerCase() === 'true' ? 'true' : 'false'}
                      onChange={(e) => updateValue(field.key, e.target.value)}
                    >
                      <option value="true">TRUE</option>
                      <option value="false">FALSE</option>
                    </select>
                  ) : field.type === 'select' && field.options ? (
                    <select
                      className="w-full bg-black border border-[var(--color-term-border)] text-sm text-[var(--color-term-fg)] px-2 py-1 font-mono focus:border-[var(--color-term-green)] focus:outline-none"
                      value={values[field.key] ?? ''}
                      onChange={(e) => updateValue(field.key, e.target.value)}
                    >
                      <option value="" disabled>-- SELECT --</option>
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      className="w-full bg-black border border-[var(--color-term-border)] text-sm text-[var(--color-term-fg)] px-2 py-1 font-mono focus:border-[var(--color-term-green)] focus:outline-none"
                      value={values[field.key] ?? ''}
                      onChange={(e) => updateValue(field.key, e.target.value)}
                    />
                  )}
                  <div className="text-[10px] text-zinc-600 truncate">{field.description}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

