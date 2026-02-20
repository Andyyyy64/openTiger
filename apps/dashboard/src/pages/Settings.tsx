import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configApi, pluginsApi, systemApi } from "../lib/api";
import { BrailleSpinner } from "../components/BrailleSpinner";
import { SettingsHeader } from "./settings/SettingsHeader";
import { SystemControlPanel } from "./settings/SystemControlPanel";
import { SettingsConfigSections } from "./settings/SettingsConfigSections";
import { LLM_EXECUTOR_OPTIONS, type SettingField } from "./settings/constants";
import { GROUPED_SETTINGS } from "./settings/grouping";
import {
  AGENT_EXECUTOR_CONFIG_KEY_BY_ROLE,
  AGENT_EXECUTOR_ROLES,
  INHERIT_EXECUTOR_TOKEN,
  collectConfiguredExecutors,
  normalizeExecutor,
  resolveRoleExecutor,
  type AgentExecutorRole,
} from "../lib/llm-executor";

const EXECUTOR_MODEL_KEYS = new Set([
  "WORKER_MODEL",
  "TESTER_MODEL",
  "DOCSER_MODEL",
  "JUDGE_MODEL",
  "PLANNER_MODEL",
]);
const API_KEY_KEYS = new Set(["GEMINI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY"]);
const AGENT_EXECUTOR_LABELS: Record<AgentExecutorRole, string> = {
  planner: "planner",
  judge: "judge",
  worker: "worker",
  tester: "tester",
  docser: "docser",
};
const AGENT_EXECUTOR_SETTINGS = AGENT_EXECUTOR_ROLES.map((role) => ({
  role,
  key: AGENT_EXECUTOR_CONFIG_KEY_BY_ROLE[role],
  label: AGENT_EXECUTOR_LABELS[role],
}));
const HIDDEN_EXECUTOR_KEYS = new Set([
  "LLM_EXECUTOR",
  ...AGENT_EXECUTOR_SETTINGS.map((item) => item.key),
]);

function formatExecutorLabel(value: string): string {
  return value === "claude_code" ? "claudecode" : value;
}

export const SettingsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
  });
  const pluginsQuery = useQuery({
    queryKey: ["plugins"],
    queryFn: () => pluginsApi.list(),
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [repoOwnerInput, setRepoOwnerInput] = useState("");
  const [repoNameInput, setRepoNameInput] = useState("");
  const [repoMessage, setRepoMessage] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  const [viewerOwnerApplied, setViewerOwnerApplied] = useState(false);
  const [latestRepoAutofilled, setLatestRepoAutofilled] = useState(false);
  const [ghDefaultsSaved, setGhDefaultsSaved] = useState(false);
  const [isAgentOverridesOpen, setIsAgentOverridesOpen] = useState(false);
  const lastSavedConfigRef = useRef<Record<string, string> | null>(null);

  const hasUnsavedChanges = useMemo(() => {
    const baseline = lastSavedConfigRef.current;
    if (!baseline) return false;
    const normalize = (o: Record<string, string>) =>
      JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
    return normalize(values) !== normalize(baseline);
  }, [values]);

  useEffect(() => {
    if (!data?.config || hasUnsavedChanges) return;
    setValues(data.config);
    lastSavedConfigRef.current = { ...data.config };
  }, [data, hasUnsavedChanges]);

  const defaultExecutor = normalizeExecutor(values.LLM_EXECUTOR);
  const configuredExecutors = useMemo(() => collectConfiguredExecutors(values), [values]);
  const usesOpenCode = configuredExecutors.has("opencode");
  const usesCodex = configuredExecutors.has("codex");
  const usesClaudeCode = configuredExecutors.has("claude_code");
  const githubAuthMode = (values.GITHUB_AUTH_MODE ?? "gh").trim().toLowerCase();
  const requiresGithubToken = githubAuthMode === "token";
  const hasGithubAuth = requiresGithubToken ? Boolean(values.GITHUB_TOKEN?.trim()) : true;
  const githubOwner = values.GITHUB_OWNER?.trim();
  const repoListOwnerFilter = githubAuthMode === "gh" ? undefined : githubOwner || undefined;
  const githubReposQuery = useQuery({
    queryKey: ["system", "github-repos", repoListOwnerFilter ?? ""],
    queryFn: () => systemApi.listGithubRepos({ owner: repoListOwnerFilter }),
    enabled: hasGithubAuth,
  });
  const githubRepos = useMemo(() => githubReposQuery.data?.repos ?? [], [githubReposQuery.data]);
  const pluginOptions = useMemo(
    () => (pluginsQuery.data ?? []).map((plugin) => plugin.id).sort((a, b) => a.localeCompare(b)),
    [pluginsQuery.data],
  );
  const viewerLogin = githubReposQuery.data?.viewerLogin?.trim() ?? "";

  const mutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: (res) => {
      if (res?.config) {
        // APIで正規化された設定値を同期し、保存直後の差分表示を防ぐ
        setValues(res.config);
        lastSavedConfigRef.current = { ...res.config };
      }
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: () => systemApi.cleanup(),
  });
  const isCleanupSuccess = cleanupMutation.isSuccess;
  const resetCleanup = cleanupMutation.reset;

  const stopAllProcessesMutation = useMutation({
    mutationFn: () => systemApi.stopAllProcesses(),
  });
  const isStopAllSuccess = stopAllProcessesMutation.isSuccess;
  const resetStopAll = stopAllProcessesMutation.reset;

  const createRepoMutation = useMutation({
    mutationFn: async () => {
      const owner = repoOwnerInput.trim();
      const repo = repoNameInput.trim();
      if (!owner || !repo) {
        throw new Error("Owner and repo are required");
      }
      return systemApi.createGithubRepo({
        owner,
        repo,
        private: true,
      });
    },
    onSuccess: (repo) => {
      setRepoMessage(`> REPO_READY: ${repo.owner}/${repo.name}`);
      setSelectedRepoFullName(`${repo.owner}/${repo.name}`);
      setValues((prev) => ({
        ...prev,
        GITHUB_OWNER: repo.owner,
        GITHUB_REPO: repo.name,
        REPO_URL: repo.url,
        BASE_BRANCH: repo.defaultBranch || prev.BASE_BRANCH,
      }));
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["system", "github-repos"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Repository creation failed";
      setRepoMessage(`> REPO_ERR: ${message}`);
    },
  });

  const selectedRepo = useMemo(
    () => githubRepos.find((repo) => repo.fullName === selectedRepoFullName) ?? null,
    [githubRepos, selectedRepoFullName],
  );

  const grouped = useMemo<[string, SettingField[]][]>(() => {
    // Swap executor-dependent items based on the active per-agent executor set
    return GROUPED_SETTINGS.map(([group, fields]) => {
      const filteredFields = fields.filter((field) => {
        if (HIDDEN_EXECUTOR_KEYS.has(field.key)) {
          return false;
        }
        if (field.key === "GITHUB_TOKEN") {
          return githubAuthMode === "token";
        }
        if (field.key.startsWith("OPENCODE_")) {
          return usesOpenCode;
        }
        if (field.key.startsWith("CODEX_")) {
          return usesCodex;
        }
        if (EXECUTOR_MODEL_KEYS.has(field.key)) {
          return usesOpenCode;
        }
        if (field.key === "ANTHROPIC_API_KEY") {
          return usesOpenCode || usesClaudeCode;
        }
        if (field.key === "OPENAI_API_KEY") {
          return usesOpenCode || usesCodex;
        }
        if (API_KEY_KEYS.has(field.key)) {
          return usesOpenCode;
        }
        if (field.key.startsWith("CLAUDE_CODE_")) {
          return usesClaudeCode;
        }
        return true;
      });
      return [group, filteredFields] as [string, SettingField[]];
    }).filter(([, fields]) => fields.length > 0);
  }, [githubAuthMode, usesOpenCode, usesCodex, usesClaudeCode]);

  const syncGhDefaultsMutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: (res) => {
      if (res?.config) {
        // 自動同期でもUI状態を保存済み設定と一致させる
        setValues(res.config);
        lastSavedConfigRef.current = { ...res.config };
      }
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["system", "github-repos"] });
    },
  });

  const handleSave = () => {
    setSaveMessage("");
    setSaveWarnings([]);
    mutation.mutate(values);
  };

  const updateValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (!mutation.isSuccess || !mutation.data) {
      return;
    }
    const warnings = mutation.data.warnings ?? [];
    setSaveWarnings(warnings);
    if (mutation.data.requiresRestart) {
      setSaveMessage("> CONFIG_SAVED_RESTART_REQUIRED");
      return;
    }
    if (warnings.length > 0) {
      setSaveMessage("> CONFIG_SAVED_WITH_WARNINGS");
      return;
    }
    setSaveMessage("> CONFIG_SAVED");
  }, [mutation.data, mutation.isSuccess]);

  useEffect(() => {
    if (!mutation.isError) {
      return;
    }
    const message = mutation.error instanceof Error ? mutation.error.message : "Failed to save";
    setSaveWarnings([]);
    setSaveMessage(`> CONFIG_ERR: ${message}`);
  }, [mutation.error, mutation.isError]);

  const fieldWarnings = useMemo<Partial<Record<string, string>>>(() => {
    if (saveWarnings.length === 0) {
      return {};
    }
    const warnings: Partial<Record<string, string>> = {};
    for (const warning of saveWarnings) {
      if (warning.toLowerCase().includes("replan requirement file")) {
        warnings.REPLAN_REQUIREMENT_PATH = warning;
      }
    }
    return warnings;
  }, [saveWarnings]);

  const applySelectedRepo = () => {
    if (!selectedRepo) return;
    // Sync GitHub and Repo keys when repository is selected
    setValues((prev) => ({
      ...prev,
      GITHUB_OWNER: selectedRepo.owner,
      GITHUB_REPO: selectedRepo.name,
      REPO_URL: selectedRepo.url,
      BASE_BRANCH: selectedRepo.defaultBranch || prev.BASE_BRANCH,
    }));
    setRepoOwnerInput(selectedRepo.owner);
    setRepoNameInput(selectedRepo.name);
    setRepoMessage(`> REPO_SELECTED: ${selectedRepo.fullName}`);
  };

  const cleanupPanel = {
    isPending: cleanupMutation.isPending,
    isSuccess: cleanupMutation.isSuccess,
    onAction: () => cleanupMutation.mutate(),
  };
  const stopAllPanel = {
    isPending: stopAllProcessesMutation.isPending,
    isSuccess: stopAllProcessesMutation.isSuccess,
    onAction: () => stopAllProcessesMutation.mutate(),
    successMessage: stopAllProcessesMutation.data?.message,
  };
  useEffect(() => {
    if (!isCleanupSuccess) return;
    const timer = window.setTimeout(() => {
      resetCleanup();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isCleanupSuccess, resetCleanup]);

  useEffect(() => {
    if (!isStopAllSuccess) return;
    const timer = window.setTimeout(() => {
      resetStopAll();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isStopAllSuccess, resetStopAll]);

  useEffect(() => {
    if (!repoOwnerInput && values.GITHUB_OWNER) {
      setRepoOwnerInput(values.GITHUB_OWNER);
    }
    if (!repoNameInput && values.GITHUB_REPO) {
      setRepoNameInput(values.GITHUB_REPO);
    }
  }, [repoNameInput, repoOwnerInput, values.GITHUB_OWNER, values.GITHUB_REPO]);

  useEffect(() => {
    if (githubAuthMode !== "gh") {
      return;
    }
    if (!viewerLogin || viewerOwnerApplied) {
      return;
    }
    setValues((prev) => ({ ...prev, GITHUB_OWNER: viewerLogin }));
    setRepoOwnerInput((prev) => (prev.trim().length > 0 ? prev : viewerLogin));
    setViewerOwnerApplied(true);
  }, [githubAuthMode, viewerLogin, viewerOwnerApplied]);

  useEffect(() => {
    if (githubAuthMode !== "gh") {
      return;
    }
    if (latestRepoAutofilled || githubRepos.length === 0) {
      return;
    }
    const latestRepo = githubRepos[0];
    if (!latestRepo) {
      return;
    }
    const currentOwner = values.GITHUB_OWNER?.trim() ?? "";
    const currentRepo = values.GITHUB_REPO?.trim() ?? "";
    const currentRepoUrl = values.REPO_URL?.trim() ?? "";
    const ownerMismatch =
      viewerLogin.length > 0 && currentOwner.toLowerCase() !== viewerLogin.toLowerCase();
    const shouldAutofill = ownerMismatch || currentRepo.length === 0 || currentRepoUrl.length === 0;
    if (!shouldAutofill) {
      setLatestRepoAutofilled(true);
      return;
    }
    setValues((prev) => ({
      ...prev,
      GITHUB_OWNER: latestRepo.owner,
      GITHUB_REPO: latestRepo.name,
      REPO_URL: latestRepo.url,
      BASE_BRANCH: latestRepo.defaultBranch || prev.BASE_BRANCH,
    }));
    setSelectedRepoFullName(latestRepo.fullName);
    setRepoOwnerInput(latestRepo.owner);
    setRepoNameInput(latestRepo.name);
    setRepoMessage(`> REPO_AUTO_SELECTED: ${latestRepo.fullName}`);
    setLatestRepoAutofilled(true);
  }, [githubAuthMode, githubRepos, latestRepoAutofilled, values, viewerLogin]);

  useEffect(() => {
    if (githubAuthMode !== "gh") {
      return;
    }
    if (!hasGithubAuth || ghDefaultsSaved || syncGhDefaultsMutation.isPending) {
      return;
    }
    if (!viewerLogin || githubRepos.length === 0) {
      return;
    }
    const latestRepo = githubRepos[0];
    if (!latestRepo) {
      return;
    }
    const nextOwner = latestRepo.owner;
    const nextRepo = latestRepo.name;
    const nextUrl = latestRepo.url;
    const nextBranch = latestRepo.defaultBranch || "main";
    const sameOwner = (values.GITHUB_OWNER?.trim() ?? "") === nextOwner;
    const sameRepo = (values.GITHUB_REPO?.trim() ?? "") === nextRepo;
    const sameUrl = (values.REPO_URL?.trim() ?? "") === nextUrl;
    const sameBranch = (values.BASE_BRANCH?.trim() ?? "") === nextBranch;
    if (sameOwner && sameRepo && sameUrl && sameBranch) {
      setGhDefaultsSaved(true);
      return;
    }
    syncGhDefaultsMutation.mutate(
      {
        GITHUB_OWNER: nextOwner,
        GITHUB_REPO: nextRepo,
        REPO_URL: nextUrl,
        BASE_BRANCH: nextBranch,
      },
      {
        onSuccess: () => {
          setValues((prev) => ({
            ...prev,
            GITHUB_OWNER: nextOwner,
            GITHUB_REPO: nextRepo,
            REPO_URL: nextUrl,
            BASE_BRANCH: nextBranch,
          }));
          setSelectedRepoFullName(latestRepo.fullName);
          setRepoOwnerInput(nextOwner);
          setRepoNameInput(nextRepo);
          setRepoMessage(`> REPO_AUTO_SELECTED: ${latestRepo.fullName}`);
          setGhDefaultsSaved(true);
        },
      },
    );
  }, [
    ghDefaultsSaved,
    githubAuthMode,
    githubRepos,
    hasGithubAuth,
    syncGhDefaultsMutation,
    values.BASE_BRANCH,
    values.GITHUB_OWNER,
    values.GITHUB_REPO,
    values.REPO_URL,
    viewerLogin,
  ]);

  useEffect(() => {
    if (selectedRepoFullName) return;
    if (!values.GITHUB_OWNER || !values.GITHUB_REPO) return;
    const fullName = `${values.GITHUB_OWNER}/${values.GITHUB_REPO}`;
    if (githubRepos.some((repo) => repo.fullName === fullName)) {
      setSelectedRepoFullName(fullName);
    }
  }, [githubRepos, selectedRepoFullName, values.GITHUB_OWNER, values.GITHUB_REPO]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-term-fg pb-24">
      <SettingsHeader
        isSaving={mutation.isPending}
        hasUnsavedChanges={hasUnsavedChanges}
        onSave={handleSave}
      />
      {saveMessage && (
        <div
          className={`font-mono text-xs ${
            mutation.isError
              ? "text-red-500"
              : saveWarnings.length > 0
                ? "text-yellow-400"
                : "text-green-400"
          }`}
        >
          {saveMessage}
        </div>
      )}
      {saveWarnings.length > 0 && (
        <div className="font-mono text-xs text-yellow-400 space-y-1">
          {saveWarnings.map((warning) => (
            <div key={warning}>&gt; {warning}</div>
          ))}
        </div>
      )}
      {/* System operations panel */}
      <SystemControlPanel cleanup={cleanupPanel} stopAll={stopAllPanel} />

      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">Executor_Selector</h2>
        </div>
        <div className="p-4 space-y-4 font-mono text-sm">
          <div className="space-y-1 max-w-xs">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Default</div>
            <select
              value={defaultExecutor}
              onChange={(event) =>
                updateValue("LLM_EXECUTOR", normalizeExecutor(event.target.value))
              }
              className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
            >
              {LLM_EXECUTOR_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {formatExecutorLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div
            className={`border transition-colors ${
              isAgentOverridesOpen
                ? "border-term-tiger/70 bg-term-tiger/5"
                : "border-term-border/60 hover:border-term-tiger/50"
            }`}
          >
            <button
              type="button"
              onClick={() => setIsAgentOverridesOpen((prev) => !prev)}
              aria-expanded={isAgentOverridesOpen}
              className="w-full px-3 py-2 text-xs text-zinc-300 flex items-center justify-between cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <span className="text-term-tiger font-bold">
                  {isAgentOverridesOpen ? "[-]" : "[+]"}
                </span>
                <span>
                  {isAgentOverridesOpen
                    ? "Per_Agent_Overrides (click to close)"
                    : "Per_Agent_Overrides (click to open)"}
                </span>
              </span>
              <span className="text-[10px] text-zinc-500">
                {AGENT_EXECUTOR_SETTINGS.length} agents
              </span>
            </button>
            {isAgentOverridesOpen && (
              <div className="px-3 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                {AGENT_EXECUTOR_SETTINGS.map((item) => {
                  const roleValue = values[item.key];
                  const hasRoleValue = typeof roleValue === "string" && roleValue.trim().length > 0;
                  const normalizedRoleValue = roleValue?.trim().toLowerCase();
                  const selectValue =
                    !hasRoleValue || normalizedRoleValue === INHERIT_EXECUTOR_TOKEN
                      ? INHERIT_EXECUTOR_TOKEN
                      : normalizeExecutor(roleValue, defaultExecutor);
                  const effectiveExecutor = resolveRoleExecutor(values, item.role);
                  return (
                    <label key={item.key} className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                        {item.label}
                      </span>
                      <select
                        value={selectValue}
                        onChange={(event) => {
                          const next = event.target.value;
                          updateValue(
                            item.key,
                            next === INHERIT_EXECUTOR_TOKEN
                              ? INHERIT_EXECUTOR_TOKEN
                              : normalizeExecutor(next, defaultExecutor),
                          );
                        }}
                        className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
                      >
                        <option value={INHERIT_EXECUTOR_TOKEN}>
                          {INHERIT_EXECUTOR_TOKEN} ({formatExecutorLabel(defaultExecutor)})
                        </option>
                        {LLM_EXECUTOR_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {formatExecutorLabel(option)}
                          </option>
                        ))}
                      </select>
                      <div className="text-[10px] text-zinc-600">
                        effective: {formatExecutorLabel(effectiveExecutor)}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className="text-[10px] text-zinc-500 flex flex-wrap gap-2">
            <span>// Active executors:</span>
            {LLM_EXECUTOR_OPTIONS.filter((option) => configuredExecutors.has(option)).map(
              (option) => (
                <span key={option} className="text-zinc-300">
                  {formatExecutorLabel(option)}
                </span>
              ),
            )}
          </div>
          <div className="text-xs text-zinc-500">
            {" // Model/API key sections are filtered by the active per-agent executors."}
          </div>
        </div>
      </section>

      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">GitHub_Repository</h2>
        </div>
        <div className="p-4 space-y-4 font-mono text-sm">
          {githubAuthMode === "gh" && (
            <div className="text-zinc-500 text-xs">
              &gt; Using `gh` auth mode. Ensure GitHub CLI is installed and `gh auth login` is
              completed.
            </div>
          )}
          {!hasGithubAuth && (
            <div className="text-yellow-500 text-xs">
              &gt; `GITHUB_AUTH_MODE=token` requires `GITHUB_TOKEN`.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2">
            <select
              value={selectedRepoFullName}
              onChange={(event) => setSelectedRepoFullName(event.target.value)}
              disabled={!hasGithubAuth || githubReposQuery.isLoading || githubRepos.length === 0}
              className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none disabled:opacity-50"
            >
              <option value="" disabled>
                -- SELECT REPOSITORY --
              </option>
              {githubRepos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
            <button
              onClick={() => githubReposQuery.refetch()}
              disabled={!hasGithubAuth || githubReposQuery.isFetching}
              className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {githubReposQuery.isFetching && (
                <BrailleSpinner variant="sort" width={6} className="[color:inherit]" />
              )}
              {githubReposQuery.isFetching ? "[ REFRESHING ]" : "[ REFRESH ]"}
            </button>
            <button
              onClick={applySelectedRepo}
              disabled={!selectedRepo}
              className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
            >
              [ APPLY ]
            </button>
          </div>

          {selectedRepo && (
            <div className="text-xs text-zinc-500 border-l border-zinc-800 pl-2 space-y-1">
              <div>URL: {selectedRepo.url}</div>
              <div>DEFAULT_BRANCH: {selectedRepo.defaultBranch}</div>
              <div>PRIVATE: {selectedRepo.private ? "true" : "false"}</div>
            </div>
          )}

          {githubReposQuery.isError && (
            <div className="text-red-500 text-xs">
              &gt; REPO_LIST_ERR:{" "}
              {githubReposQuery.error instanceof Error
                ? githubReposQuery.error.message
                : "Failed to load repositories"}
            </div>
          )}

          <div className="border-t border-term-border pt-4 space-y-2">
            <div className="text-zinc-500 text-xs">
              {"// Create a new private repository and apply it immediately."}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
              <input
                type="text"
                value={repoOwnerInput}
                onChange={(event) => setRepoOwnerInput(event.target.value)}
                placeholder="GitHub owner"
                className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
              />
              <input
                type="text"
                value={repoNameInput}
                onChange={(event) => setRepoNameInput(event.target.value)}
                placeholder="Repository name"
                className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
              />
              <button
                onClick={() => createRepoMutation.mutate()}
                disabled={!hasGithubAuth || createRepoMutation.isPending}
                className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {createRepoMutation.isPending && (
                  <BrailleSpinner variant="pendulum" width={6} className="[color:inherit]" />
                )}
                {createRepoMutation.isPending ? "[ CREATING ]" : "[ CREATE_NEW ]"}
              </button>
            </div>
          </div>

          {repoMessage && <div className="text-[10px] text-zinc-500">{repoMessage}</div>}
        </div>
      </section>

      {isLoading && (
        <div className="text-center text-zinc-500 monitor-scan">&gt; Scanning configuration...</div>
      )}
      {error && <div className="text-center text-red-500">&gt; CONFIG LOAD ERROR</div>}

      <SettingsConfigSections
        grouped={grouped}
        values={values}
        onChange={updateValue}
        fieldWarnings={fieldWarnings}
        pluginOptions={pluginOptions}
      />

      {hasUnsavedChanges && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-5 py-3 border border-amber-500 bg-black shadow-lg shadow-amber-500/20">
          <span className="text-amber-400 text-sm font-mono">Unsaved changes</span>
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="border border-amber-500 bg-amber-500/20 text-amber-400 hover:bg-amber-500 hover:text-black px-4 py-1.5 text-sm font-bold uppercase transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {mutation.isPending && (
              <BrailleSpinner variant="pendulum" width={6} className="[color:inherit]" />
            )}
            {mutation.isPending ? "[ SAVING... ]" : "[ SAVE ]"}
          </button>
        </div>
      )}
    </div>
  );
};
