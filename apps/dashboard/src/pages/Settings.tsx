import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configApi, systemApi } from "../lib/api";
import { SettingsHeader } from "./settings/SettingsHeader";
import { SystemControlPanel } from "./settings/SystemControlPanel";
import { SettingsConfigSections } from "./settings/SettingsConfigSections";
import { LLM_EXECUTOR_OPTIONS, type SettingField } from "./settings/constants";
import { GROUPED_SETTINGS } from "./settings/grouping";
import { normalizeExecutor } from "../lib/llm-executor";

const EXECUTOR_MODEL_KEYS = new Set([
  "WORKER_MODEL",
  "TESTER_MODEL",
  "DOCSER_MODEL",
  "JUDGE_MODEL",
  "PLANNER_MODEL",
]);
const API_KEY_KEYS = new Set(["GEMINI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY"]);

export const SettingsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
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

  useEffect(() => {
    if (data?.config) {
      setValues(data.config);
    }
  }, [data]);

  const selectedExecutor = normalizeExecutor(values.LLM_EXECUTOR);
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
  const viewerLogin = githubReposQuery.data?.viewerLogin?.trim() ?? "";

  const mutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: () => {
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
    // Swap only executor-dependent items; always show common settings
    return GROUPED_SETTINGS.map(([group, fields]) => {
      const filteredFields = fields.filter((field) => {
        if (field.key === "LLM_EXECUTOR") {
          return false;
        }
        if (field.key === "GITHUB_TOKEN") {
          return githubAuthMode === "token";
        }
        if (field.key.startsWith("OPENCODE_")) {
          return selectedExecutor === "opencode";
        }
        if (field.key.startsWith("CODEX_")) {
          return selectedExecutor === "codex";
        }
        if (EXECUTOR_MODEL_KEYS.has(field.key)) {
          return selectedExecutor === "opencode";
        }
        if (field.key === "ANTHROPIC_API_KEY") {
          return selectedExecutor !== "codex";
        }
        if (field.key === "OPENAI_API_KEY") {
          return selectedExecutor === "opencode" || selectedExecutor === "codex";
        }
        if (API_KEY_KEYS.has(field.key)) {
          return selectedExecutor === "opencode";
        }
        if (field.key.startsWith("CLAUDE_CODE_")) {
          return selectedExecutor === "claude_code";
        }
        return true;
      });
      return [group, filteredFields] as [string, SettingField[]];
    }).filter(([, fields]) => fields.length > 0);
  }, [githubAuthMode, selectedExecutor]);

  const syncGhDefaultsMutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: () => {
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
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-term-fg">
      <SettingsHeader isSaving={mutation.isPending} onSave={handleSave} />
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
        <div className="p-4 space-y-3 font-mono text-sm">
          <div className="max-w-xs">
            <select
              value={selectedExecutor}
              onChange={(event) =>
                updateValue("LLM_EXECUTOR", normalizeExecutor(event.target.value))
              }
              className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
            >
              {LLM_EXECUTOR_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === "claude_code" ? "claudecode" : option}
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs text-zinc-500">
            {" // Show only settings relevant to the selected executor."}
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
              className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
            >
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
                className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
              >
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
      />
    </div>
  );
};
