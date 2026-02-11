import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  configApi,
  logsApi,
  systemApi,
  type GitHubRepoListItem,
  type SystemProcess,
} from "../lib/api";
import { NeofetchPanel } from "../components/NeofetchPanel";

const MAX_PLANNERS = 1;

const STATUS_LABELS: Record<SystemProcess["status"], string> = {
  idle: "IDLE",
  running: "RUNNING",
  completed: "DONE",
  failed: "FAILED",
  stopped: "STOPPED",
};

const STATUS_COLORS: Record<SystemProcess["status"], string> = {
  idle: "text-zinc-500",
  running: "text-term-tiger animate-pulse",
  completed: "text-zinc-300",
  failed: "text-red-500",
  stopped: "text-yellow-500",
};

type StartResult = {
  started: string[];
  errors: string[];
  warnings: string[];
};

type ExecutionEnvironment = "host" | "sandbox";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() !== "false";
}

function parseCount(
  value: string | undefined,
  fallback: number,
  label: string,
  max?: number,
): { count: number; warning?: string } {
  const parsed = value ? parseInt(value, 10) : NaN;
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  const base = Math.max(0, normalized);
  if (typeof max !== "number") {
    return { count: base };
  }
  const clamped = Math.min(base, max);
  if (base > max) {
    return { count: clamped, warning: `${label} max limit ${max}` };
  }
  return { count: clamped };
}

const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleTimeString() : "--:--:--";

function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function normalizeExecutionEnvironment(value: string | undefined): ExecutionEnvironment {
  return value?.trim().toLowerCase() === "sandbox" ? "sandbox" : "host";
}

export const StartPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [clearLogMessage, setClearLogMessage] = useState("");
  const [startResult, setStartResult] = useState<StartResult | null>(null);
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [repoMessage, setRepoMessage] = useState("");
  const [isRepoManagerOpen, setIsRepoManagerOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
  });
  const configValues = config?.config ?? {};
  const repoMode = (configValues.REPO_MODE ?? "git").toLowerCase();
  const isGitMode = repoMode === "git";
  const githubAuthMode = (configValues.GITHUB_AUTH_MODE ?? "gh").trim().toLowerCase();
  const requiresGithubToken = githubAuthMode === "token";
  const hasGithubAuth = requiresGithubToken ? Boolean(configValues.GITHUB_TOKEN?.trim()) : true;
  const repoUrl = configValues.REPO_URL?.trim();
  const isRepoMissing =
    isGitMode && !repoUrl && (!configValues.GITHUB_OWNER || !configValues.GITHUB_REPO);
  const currentRepoName =
    configValues.GITHUB_OWNER && configValues.GITHUB_REPO
      ? `${configValues.GITHUB_OWNER}/${configValues.GITHUB_REPO}`
      : "--";
  const githubReposQuery = useQuery({
    queryKey: ["system", "github-repos", configValues.GITHUB_OWNER?.trim() ?? ""],
    queryFn: () => systemApi.listGithubRepos({ owner: configValues.GITHUB_OWNER?.trim() || undefined }),
    enabled: hasGithubAuth,
  });
  const githubRepos = useMemo(() => githubReposQuery.data ?? [], [githubReposQuery.data]);
  const selectedRepo = useMemo(
    () => githubRepos.find((repo) => repo.fullName === selectedRepoFullName) ?? null,
    [githubRepos, selectedRepoFullName],
  );

  const { data: health, isError: isHealthError } = useQuery({
    queryKey: ["system", "health"],
    queryFn: () => systemApi.health(),
    refetchInterval: 30000,
    retry: 1,
  });

  const { data: processes } = useQuery({
    queryKey: ["system", "processes"],
    queryFn: () => systemApi.processes(),
    refetchInterval: 5000,
  });
  const neofetchQuery = useQuery({
    queryKey: ["system", "host-neofetch"],
    queryFn: () => systemApi.neofetch(),
    retry: 0,
    refetchInterval: false,
  });
  const currentExecutor = config?.config.LLM_EXECUTOR;
  const shouldCheckClaudeAuth = isClaudeExecutor(currentExecutor);
  const neofetchOutput =
    neofetchQuery.data?.available && neofetchQuery.data.output
      ? neofetchQuery.data.output
      : undefined;
  const claudeAuthEnvironment = normalizeExecutionEnvironment(config?.config.EXECUTION_ENVIRONMENT);
  const claudeAuthQuery = useQuery({
    queryKey: ["system", "claude-auth", currentExecutor ?? "", claudeAuthEnvironment],
    queryFn: () => systemApi.claudeAuthStatus(claudeAuthEnvironment),
    enabled: shouldCheckClaudeAuth,
    retry: 0,
    refetchInterval: 120000,
  });

  const planner = useMemo(
    () => processes?.find((process) => process.name === "planner"),
    [processes],
  );

  useEffect(() => {
    if (!config?.config) return;
    if (!repoOwner && config.config.GITHUB_OWNER) {
      setRepoOwner(config.config.GITHUB_OWNER);
    }
    if (!repoName && config.config.GITHUB_REPO) {
      setRepoName(config.config.GITHUB_REPO);
    }
  }, [config?.config, repoName, repoOwner]);
  useEffect(() => {
    if (selectedRepoFullName) return;
    if (!configValues.GITHUB_OWNER || !configValues.GITHUB_REPO) return;
    const fullName = `${configValues.GITHUB_OWNER}/${configValues.GITHUB_REPO}`;
    if (githubRepos.some((repo) => repo.fullName === fullName)) {
      setSelectedRepoFullName(fullName);
    }
  }, [
    configValues.GITHUB_OWNER,
    configValues.GITHUB_REPO,
    githubRepos,
    selectedRepoFullName,
  ]);
  useEffect(() => {
    if (isRepoMissing) {
      setIsRepoManagerOpen(true);
    }
  }, [isRepoMissing]);

  const clearLogsMutation = useMutation({
    mutationFn: () => logsApi.clear(),
    onSuccess: (data) => {
      const suffix = data.failed > 0 ? ` (FAILED ${data.failed})` : "";
      setClearLogMessage(`> LOGS_CLEARED: ${data.removed}${suffix}`);
    },
    onError: (error) => {
      setClearLogMessage(error instanceof Error ? `> CLEAR_ERR: ${error.message}` : "> CLEAR_FAIL");
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const settings = config?.config;
      if (!settings) throw new Error("Config not loaded");
      const repoMode = (settings.REPO_MODE ?? "git").toLowerCase();
      const executionEnvironment = normalizeExecutionEnvironment(settings.EXECUTION_ENVIRONMENT);
      const sandboxExecution = executionEnvironment === "sandbox";
      const hasRepoUrl = Boolean(settings.REPO_URL?.trim());
      if (repoMode === "git" && !hasRepoUrl && (!settings.GITHUB_OWNER || !settings.GITHUB_REPO)) {
        throw new Error("GitHub repo is not configured");
      }

      const workerCount = parseCount(settings.WORKER_COUNT, 1, "Worker");
      const testerCount = parseCount(settings.TESTER_COUNT, 1, "Tester");
      const docserCount = parseCount(settings.DOCSER_COUNT, 1, "Docser");
      const judgeCount = parseCount(settings.JUDGE_COUNT, 1, "Judge");
      const plannerCount = parseCount(settings.PLANNER_COUNT, 1, "Planner", MAX_PLANNERS);

      const warnings = [
        workerCount.warning,
        testerCount.warning,
        docserCount.warning,
        judgeCount.warning,
        plannerCount.warning,
      ].filter((value): value is string => typeof value === "string");

      const hasRequirementContent = content.trim().length > 0;
      if (hasRequirementContent) {
        try {
          const syncResult = await systemApi.syncRequirement({
            content,
          });
          if (syncResult.committed) {
            warnings.push("Requirement snapshot committed to docs/requirement.md");
          } else if (syncResult.commitReason === "no_changes") {
            warnings.push("Requirement snapshot is already up to date");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Requirement snapshot sync failed";
          if (message.includes("Requirement target repository is unresolved")) {
            warnings.push(
              "Requirement snapshot target is unresolved. Planner will use a transient requirement file for this run.",
            );
          } else {
            throw error;
          }
        }
      }
      const preflight = await systemApi.preflight({
        content,
        autoCreateIssueTasks: true,
      });
      const recommendations = preflight.recommendations;
      const backlog =
        preflight.preflight.github.issueTaskBacklogCount +
        preflight.preflight.github.openPrCount +
        preflight.preflight.local.queuedTaskCount +
        preflight.preflight.local.runningTaskCount +
        preflight.preflight.local.failedTaskCount +
        preflight.preflight.local.blockedTaskCount +
        preflight.preflight.local.pendingJudgeTaskCount;

      if (!recommendations.startPlanner && backlog === 0) {
        throw new Error("Requirements empty and no issue/PR backlog found");
      }

      warnings.push(...preflight.preflight.github.warnings.map((warning) => `GitHub: ${warning}`));
      warnings.push(...recommendations.reasons);

      if (preflight.preflight.github.generatedTaskCount > 0) {
        warnings.push(`Issue tasks generated: ${preflight.preflight.github.generatedTaskCount}`);
      }
      if (hasRequirementContent && !recommendations.startPlanner) {
        warnings.push("Open issue/PR backlog detected; planner launch skipped for this run");
      }
      if (sandboxExecution) {
        warnings.push(
          "Sandbox mode is enabled. worker/tester/docser host processes are skipped; tasks run in docker.",
        );
      }

      const started: string[] = [];
      const errors: string[] = [];

      const startProcess = async (
        name: string,
        payload?: { requirementPath?: string; content?: string },
      ) => {
        try {
          await systemApi.startProcess(name, payload);
          started.push(name);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          errors.push(`${name}: ${message}`);
        }
      };

      const plannerStartCount = Math.min(
        plannerCount.count,
        recommendations.plannerCount ?? (recommendations.startPlanner ? 1 : 0),
      );
      for (let i = 1; i <= plannerStartCount; i += 1) {
        const plannerName = i === 1 ? "planner" : `planner-${i}`;
        await startProcess(plannerName, { content });
      }
      if (recommendations.startDispatcher) {
        await startProcess("dispatcher");
      }
      const judgeStartCount = Math.min(
        judgeCount.count,
        recommendations.judgeCount ?? (recommendations.startJudge ? 1 : 0),
      );
      if (judgeStartCount > 0) {
        for (let i = 1; i <= judgeStartCount; i += 1) {
          const judgeName = i === 1 ? "judge" : `judge-${i}`;
          await startProcess(judgeName);
        }
      } else if (
        parseBoolean(settings.JUDGE_ENABLED, true) &&
        preflight.preflight.github.openPrCount > 0
      ) {
        warnings.push("Open PR backlog exists but judge was not recommended");
      }
      if (recommendations.startCycleManager) {
        await startProcess("cycle-manager");
      }

      const workerStartCount = sandboxExecution
        ? 0
        : Math.min(workerCount.count, recommendations.workerCount);
      const testerStartCount = sandboxExecution
        ? 0
        : Math.min(testerCount.count, recommendations.testerCount);
      const docserStartCount = sandboxExecution
        ? 0
        : Math.min(docserCount.count, recommendations.docserCount);

      for (let i = 1; i <= workerStartCount; i += 1) await startProcess(`worker-${i}`);
      for (let i = 1; i <= testerStartCount; i += 1) await startProcess(`tester-${i}`);
      for (let i = 1; i <= docserStartCount; i += 1) await startProcess(`docser-${i}`);

      return { started, errors, warnings };
    },
    onSuccess: (result) => {
      setStartResult(result);
      queryClient.invalidateQueries({ queryKey: ["system", "processes"] });
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (error) => {
      setStartResult({
        started: [],
        errors: [error instanceof Error ? error.message : "Launch failed"],
        warnings: [],
      });
    },
  });

  const createRepoMutation = useMutation({
    mutationFn: async () => {
      if (!repoOwner.trim() || !repoName.trim()) {
        throw new Error("Owner and repo are required");
      }
      return systemApi.createGithubRepo({
        owner: repoOwner.trim(),
        repo: repoName.trim(),
        private: true,
      });
    },
    onSuccess: (repo) => {
      setRepoMessage(`> REPO_READY: ${repo.owner}/${repo.name}`);
      setSelectedRepoFullName(`${repo.owner}/${repo.name}`);
      void configApi
        .update({
          REPO_MODE: "git",
          GITHUB_OWNER: repo.owner,
          GITHUB_REPO: repo.name,
          REPO_URL: repo.url,
          BASE_BRANCH: repo.defaultBranch,
        })
        .then(() => {
          setRepoOwner(repo.owner);
          setRepoName(repo.name);
          setRepoMessage(`> REPO_SELECTED: ${repo.owner}/${repo.name}`);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Repository apply failed";
          setRepoMessage(`> REPO_ERR: ${message}`);
        })
        .finally(() => {
          queryClient.invalidateQueries({ queryKey: ["config"] });
          queryClient.invalidateQueries({ queryKey: ["system", "github-repos"] });
        });
    },
    onError: (error) => {
      setRepoMessage(error instanceof Error ? `> REPO_ERR: ${error.message}` : "> REPO_FAIL");
    },
  });
  const applyRepoMutation = useMutation({
    mutationFn: async (
      repo: Pick<GitHubRepoListItem, "owner" | "name" | "url" | "defaultBranch"> & {
        fullName?: string;
      },
    ) =>
      configApi.update({
        REPO_MODE: "git",
        GITHUB_OWNER: repo.owner,
        GITHUB_REPO: repo.name,
        REPO_URL: repo.url,
        BASE_BRANCH: repo.defaultBranch,
      }),
    onSuccess: (_, repo) => {
      setRepoOwner(repo.owner);
      setRepoName(repo.name);
      const repoFullName = repo.fullName ?? `${repo.owner}/${repo.name}`;
      setRepoMessage(`> REPO_SELECTED: ${repoFullName}`);
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["system", "github-repos"] });
    },
    onError: (error) => {
      setRepoMessage(error instanceof Error ? `> REPO_ERR: ${error.message}` : "> REPO_FAIL");
    },
  });

  const executionEnvironmentMutation = useMutation({
    mutationFn: (executionEnvironment: ExecutionEnvironment) =>
      configApi.update({ EXECUTION_ENVIRONMENT: executionEnvironment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const executionEnvironment = normalizeExecutionEnvironment(configValues.EXECUTION_ENVIRONMENT);
  const launchModeLabel = executionEnvironment === "sandbox" ? "docker" : "process";
  const workerCount = parseCount(configValues.WORKER_COUNT, 1, "Worker").count;
  const testerCount = parseCount(configValues.TESTER_COUNT, 1, "Tester").count;
  const docserCount = parseCount(configValues.DOCSER_COUNT, 1, "Docser").count;
  const judgeCount = parseCount(configValues.JUDGE_COUNT, 1, "Judge").count;
  const plannerCount = parseCount(configValues.PLANNER_COUNT, 1, "Planner", MAX_PLANNERS).count;

  const runningWorkers =
    processes?.filter(
      (process) => process.name.startsWith("worker-") && process.status === "running",
    ).length ?? 0;
  const runningTesters =
    processes?.filter(
      (process) => process.name.startsWith("tester-") && process.status === "running",
    ).length ?? 0;
  const runningDocsers =
    processes?.filter(
      (process) => process.name.startsWith("docser-") && process.status === "running",
    ).length ?? 0;

  const runningJudges =
    processes?.filter(
      (process) =>
        (process.name === "judge" || process.name.startsWith("judge-")) &&
        process.status === "running",
    ).length ?? 0;
  const runningPlanners =
    processes?.filter(
      (process) =>
        (process.name === "planner" || process.name.startsWith("planner-")) &&
        process.status === "running",
    ).length ?? 0;

  const dispatcherStatus =
    processes?.find((process) => process.name === "dispatcher")?.status ?? "idle";
  const judgeStatus = runningJudges > 0 ? "running" : "idle";
  const cycleStatus =
    processes?.find((process) => process.name === "cycle-manager")?.status ?? "idle";

  const isContentEmpty = content.trim().length === 0;
  const isStartBlocked = isRepoMissing;
  const isHealthy = health?.status === "ok" && !isHealthError;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 text-term-fg">
      <div>
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; System_Bootstrap
        </h1>
        <p className="text-xs text-zinc-500 mt-1 font-mono">
          // Initialize planner from requirements.md and spawn subprocesses.
        </p>
      </div>
      {shouldCheckClaudeAuth && claudeAuthQuery.data && !claudeAuthQuery.data.authenticated && (
        <div className="border border-yellow-600 bg-yellow-900/10 p-3 text-xs font-mono text-yellow-500">
          &gt; WARN: Claude Code is not ready.{" "}
          {claudeAuthQuery.data.message ??
            "Run `claude` and complete `/login` before starting execution."}
        </div>
      )}
      {shouldCheckClaudeAuth && claudeAuthQuery.isError && (
        <div className="border border-yellow-600 bg-yellow-900/10 p-3 text-xs font-mono text-yellow-500">
          &gt; WARN: Failed to check Claude Code authentication status.
        </div>
      )}
      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
          <h2 className="text-sm font-bold uppercase tracking-wider">Execution_Environment</h2>
        </div>
        <div className="p-4 space-y-3 font-mono text-sm">
          <div className="grid grid-cols-1 md:grid-cols-[220px_auto] gap-3 items-center">
            <select
              value={executionEnvironment}
              onChange={(event) =>
                executionEnvironmentMutation.mutate(
                  normalizeExecutionEnvironment(event.target.value),
                )
              }
              disabled={executionEnvironmentMutation.isPending}
              className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none disabled:opacity-50"
            >
              <option value="host">host</option>
              <option value="sandbox">sandbox</option>
            </select>
            <div className="text-xs text-zinc-500">
              {`// launch mode: ${launchModeLabel} (${executionEnvironment === "sandbox" ? "docker container" : "host process"})`}
            </div>
          </div>
          <div className="text-[10px] text-zinc-500">
            {"// Applies when processes are (re)started from this page."}
          </div>
          {executionEnvironmentMutation.isPending && (
            <div className="text-[10px] text-zinc-500">&gt; ENV_UPDATING...</div>
          )}
          {executionEnvironmentMutation.isSuccess && !executionEnvironmentMutation.isPending && (
            <div className="text-[10px] text-green-400">&gt; ENV_UPDATED</div>
          )}
          {executionEnvironmentMutation.isError && (
            <div className="text-[10px] text-red-500">
              &gt; ENV_UPDATE_ERR:{" "}
              {executionEnvironmentMutation.error instanceof Error
                ? executionEnvironmentMutation.error.message
                : "Failed to update execution environment"}
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* System Status Panel */}
        <section className="border border-term-border p-0 h-full">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between items-center">
            <h2 className="text-sm font-bold uppercase tracking-wider">Status_Monitor</h2>
            <span className="text-xs text-zinc-500">
              {isHealthy ? "[API: ONLINE]" : "[API: OFFLINE]"}
            </span>
          </div>

          <div className="p-4 space-y-4 font-mono text-sm">
            <div className="grid grid-cols-2 gap-y-2">
              <div className="text-zinc-500">Dispatcher</div>
              <div className={STATUS_COLORS[dispatcherStatus]}>
                {STATUS_LABELS[dispatcherStatus]}
              </div>

              <div className="text-zinc-500">Planner</div>
              <div className={STATUS_COLORS[runningPlanners > 0 ? "running" : "idle"]}>
                {runningPlanners > 0 ? "RUNNING" : "IDLE"} ({runningPlanners}/{plannerCount})
              </div>

              <div className="text-zinc-500">Judge</div>
              <div className={STATUS_COLORS[judgeStatus]}>
                {STATUS_LABELS[judgeStatus]} ({runningJudges}/{judgeCount})
              </div>

              <div className="text-zinc-500">CycleManager</div>
              <div className={STATUS_COLORS[cycleStatus]}>{STATUS_LABELS[cycleStatus]}</div>
            </div>

            <div className="border-t border-term-border pt-4 mt-2">
              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Active Workers</span>
                <span>
                  {runningWorkers} / {workerCount}
                </span>
              </div>
              <div className="w-full bg-zinc-900 h-1 mb-3">
                <div
                  className="h-full bg-term-tiger"
                  style={{
                    width: `${workerCount > 0 ? (runningWorkers / workerCount) * 100 : 0}%`,
                  }}
                ></div>
              </div>

              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Active Testers</span>
                <span>
                  {runningTesters} / {testerCount}
                </span>
              </div>
              <div className="w-full bg-zinc-900 h-1 mb-3">
                <div
                  className="h-full bg-term-tiger"
                  style={{
                    width: `${testerCount > 0 ? (runningTesters / testerCount) * 100 : 0}%`,
                  }}
                ></div>
              </div>

              <div className="flex justify-between mb-1">
                <span className="text-zinc-500">Docs</span>
                <span>
                  {runningDocsers} / {docserCount}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Start Control Panel */}
        <section className="border border-term-border p-0 h-full flex flex-col">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
            <h2 className="text-sm font-bold uppercase tracking-wider">Boot_Sequence</h2>
          </div>

          <div className="p-4 flex-1 flex flex-col gap-4">
            <div className="border border-term-border p-3 text-xs font-mono space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-zinc-400">Current Git Repository</div>
                <button
                  onClick={() => setIsRepoManagerOpen((prev) => !prev)}
                  className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors"
                >
                  {isRepoManagerOpen ? "[ CLOSE_REPO ]" : "[ CHANGE_REPO ]"}
                </button>
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="text-zinc-300">{currentRepoName}</div>
                {repoUrl ? (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-block text-term-tiger hover:underline break-all"
                  >
                    {repoUrl}
                  </a>
                ) : (
                  <div className="text-yellow-500">Repo URL is not configured</div>
                )}
              </div>
            </div>
            {isRepoManagerOpen && (
              <div className="border border-term-border p-3 text-xs font-mono space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2">
                  <select
                    value={selectedRepoFullName}
                    onChange={(event) => setSelectedRepoFullName(event.target.value)}
                    disabled={!hasGithubAuth || githubReposQuery.isLoading || githubRepos.length === 0}
                    className="w-full bg-black border border-term-border px-3 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none disabled:opacity-50"
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
                    onClick={() => selectedRepo && applyRepoMutation.mutate(selectedRepo)}
                    disabled={!selectedRepo || applyRepoMutation.isPending}
                    className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
                  >
                    {applyRepoMutation.isPending ? "[ APPLYING ]" : "[ APPLY ]"}
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    type="text"
                    className="w-full bg-black border border-term-border px-3 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                    value={repoOwner}
                    onChange={(event) => setRepoOwner(event.target.value)}
                    placeholder="GitHub owner"
                  />
                  <input
                    type="text"
                    className="w-full bg-black border border-term-border px-3 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    placeholder="Repository name"
                  />
                  <button
                    onClick={() => createRepoMutation.mutate()}
                    disabled={!hasGithubAuth || createRepoMutation.isPending}
                    className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50"
                  >
                    {createRepoMutation.isPending ? "[ CREATING ]" : "[ CREATE_NEW ]"}
                  </button>
                </div>
                {!hasGithubAuth && (
                  <div className="text-yellow-500">
                    `GITHUB_AUTH_MODE=token` requires `GITHUB_TOKEN` in System config
                  </div>
                )}
                {githubReposQuery.isError && (
                  <div className="text-red-500">
                    &gt; REPO_LIST_ERR:{" "}
                    {githubReposQuery.error instanceof Error
                      ? githubReposQuery.error.message
                      : "Failed to load repositories"}
                  </div>
                )}
                {repoMessage && <div className="text-[10px] text-zinc-500">{repoMessage}</div>}
              </div>
            )}
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-500 uppercase">Requirement Input (Paste)</label>
              <button
                onClick={() => clearLogsMutation.mutate()}
                disabled={clearLogsMutation.isPending}
                className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-sm uppercase transition-colors disabled:opacity-50"
              >
                [ CLEAR_LOG ]
              </button>
            </div>
            {clearLogMessage && (
              <div className="text-[10px] text-zinc-500 font-mono -mt-2">{clearLogMessage}</div>
            )}

            <textarea
              className="flex-1 bg-black border border-term-border p-3 text-xs font-mono text-zinc-300 focus:border-term-tiger focus:outline-none resize-none min-h-[150px]"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="> Waiting for content..."
            />

            <div className="flex justify-between items-center pt-2">
              <span className="text-xs text-zinc-600">{content.length} bytes loaded</span>
              <button
                onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending || isStartBlocked}
                className="bg-term-tiger text-black px-6 py-2 text-sm font-bold uppercase hover:opacity-90 disabled:opacity-50 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {startMutation.isPending ? "> INITIATING..." : "> EXECUTE RUN"}
              </button>
            </div>

            {/* Result Console */}
            {(startResult || isContentEmpty || isStartBlocked) && (
              <div className="border-t border-term-border mt-2 pt-2 gap-1 flex flex-col text-xs font-mono">
                {isContentEmpty && (
                  <div className="text-yellow-500">
                    &gt; WARN: Content empty (Issue/PR preflight only)
                  </div>
                )}
                {isStartBlocked && (
                  <div className="text-yellow-500">&gt; WARN: GitHub repo is missing</div>
                )}
                {startResult?.warnings.map((w) => (
                  <div key={w} className="text-yellow-500">
                    &gt; WARN: {w}
                  </div>
                ))}
                {startResult?.errors.map((e) => (
                  <div key={e} className="text-red-500">
                    &gt; ERR: {e}
                  </div>
                ))}
                {startResult?.started.length && (
                  <div className="text-term-tiger">&gt; BOOT SEQ INITIATED</div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
      {neofetchOutput && <NeofetchPanel output={neofetchOutput} />}
      {/* Legacy Planner Logs */}
      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">Planner_Output</h2>
          <span className={`text-xs uppercase ${STATUS_COLORS[planner?.status ?? "idle"]}`}>
            [{STATUS_LABELS[planner?.status ?? "idle"]}]
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
            <span className="text-zinc-400">{planner?.logPath || "--"}</span>
          </div>
          {planner?.message && planner.status === "failed" && (
            <div className="text-red-500 mt-2 border-l-2 border-red-500 pl-2">
              &gt; CRITICAL_ERR: {planner.message}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
