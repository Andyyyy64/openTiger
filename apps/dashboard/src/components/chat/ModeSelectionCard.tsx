import React, { useEffect, useRef, useState } from "react";
import type { GitHubRepoListItem } from "../../lib/api";
import { BrailleSpinner } from "../BrailleSpinner";

export interface ModeSelectionStartConfig {
  mode: "direct" | "local-git" | "github";
  githubOwner?: string;
  githubRepo?: string;
  baseBranch?: string;
}

interface ModeSelectionCardProps {
  onStartExecution?: (config: ModeSelectionStartConfig) => void;
  /** Current configured repo from global config */
  currentRepo?: { owner: string; repo: string; url?: string; branch?: string } | null;
  /** LOCAL_REPO_PATH from config — shown for direct/local-git modes */
  localRepoPath?: string;
  /** GitHub repos from API */
  githubRepos?: GitHubRepoListItem[];
  isLoadingRepos?: boolean;
  onRefreshRepos?: () => void;
  onCreateRepo?: (owner: string, repo: string) => Promise<void>;
  isCreatingRepo?: boolean;
  /** Mutation state from parent */
  executionStatus?: "idle" | "pending" | "success" | "error";
}

export const ModeSelectionCard: React.FC<ModeSelectionCardProps> = ({
  onStartExecution,
  currentRepo,
  localRepoPath,
  githubRepos = [],
  isLoadingRepos,
  onRefreshRepos,
  onCreateRepo,
  isCreatingRepo,
  executionStatus = "idle",
}) => {
  const [expanded, setExpanded] = useState<"github" | null>(null);
  const [selectedFullName, setSelectedFullName] = useState("");
  const [createOwner, setCreateOwner] = useState("");
  const [createName, setCreateName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [clicked, setClicked] = useState(false);
  const userHasSelected = useRef(false);

  // Reset clicked state when execution mutation is reset (e.g. conversation switch)
  useEffect(() => {
    if (executionStatus === "idle") setClicked(false);
  }, [executionStatus]);

  // Auto-select on initial load only: current configured repo > first in list
  useEffect(() => {
    // Skip auto-select if user has manually picked a repo
    if (userHasSelected.current) return;

    if (currentRepo?.owner && currentRepo?.repo) {
      const configFullName = `${currentRepo.owner}/${currentRepo.repo}`;
      if (githubRepos.some((r) => r.fullName === configFullName)) {
        setSelectedFullName(configFullName);
        return;
      }
    }
    if (githubRepos.length > 0 && githubRepos[0]) {
      setSelectedFullName(githubRepos[0].fullName);
    }
  }, [currentRepo, githubRepos]);

  const selectedRepo = githubRepos.find((r) => r.fullName === selectedFullName);

  const busy = clicked || executionStatus === "pending";

  const handleDirect = () => {
    if (!onStartExecution || busy) return;
    setClicked(true);
    onStartExecution({ mode: "direct" });
  };

  const handleLocalGit = () => {
    if (!onStartExecution || busy) return;
    setClicked(true);
    onStartExecution({ mode: "local-git" });
  };

  const handleGitStart = () => {
    if (!onStartExecution || busy) return;
    // Prefer selectedRepo (from fetched list) but fall back to selectedFullName
    // so a just-created repo is usable before the query refetches.
    const owner = selectedRepo?.owner ?? selectedFullName.split("/")[0];
    const repo = selectedRepo?.name ?? selectedFullName.split("/")[1];
    if (!owner || !repo) return;
    setClicked(true);
    onStartExecution({
      mode: "github",
      githubOwner: owner,
      githubRepo: repo,
      baseBranch: selectedRepo?.defaultBranch || "main",
    });
  };

  const handleCreateRepo = async () => {
    if (!onCreateRepo || !createOwner.trim() || !createName.trim()) return;
    const owner = createOwner.trim();
    const name = createName.trim();
    await onCreateRepo(owner, name);
    // After creation succeeds, select the new repo and close create form
    const newFullName = `${owner}/${name}`;
    userHasSelected.current = true;
    setSelectedFullName(newFullName);
    setShowCreate(false);
  };

  if (executionStatus === "success") {
    return (
      <div className="py-2 px-3">
        <div className="border border-green-700/40 bg-green-900/10 p-4 flex items-center gap-2">
          <span className="text-green-500 text-xs font-bold uppercase tracking-wider">
            EXECUTION STARTED
          </span>
        </div>
      </div>
    );
  }

  if (executionStatus === "error") {
    return (
      <div className="py-2 px-3">
        <div className="border border-red-700/40 bg-red-900/10 p-4 flex items-center gap-2">
          <span className="text-red-400 text-xs font-bold uppercase tracking-wider">
            FAILED TO START EXECUTION
          </span>
        </div>
      </div>
    );
  }

  if (clicked || executionStatus === "pending") {
    return (
      <div className="py-2 px-3">
        <div className="border border-term-tiger/30 bg-term-tiger/5 p-4 flex items-center gap-2">
          <BrailleSpinner variant="pendulum" width={6} className="text-term-tiger" />
          <span className="text-term-tiger text-xs font-bold uppercase tracking-wider">
            EXECUTION STARTING...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="py-2 px-3">
      <div className="border border-term-tiger/30 bg-term-tiger/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-term-tiger text-xs font-bold uppercase tracking-wider">
            SELECT EXECUTION MODE
          </span>
        </div>

        {!expanded && (
          <div className="space-y-3">
            {localRepoPath && (
              <div className="text-[11px] text-zinc-500">
                Local path: <span className="text-zinc-300 font-mono">{localRepoPath}</span>
              </div>
            )}
            <div className="flex gap-3">
              <div className="flex flex-col items-start">
                <button
                  onClick={handleDirect}
                  disabled={!localRepoPath}
                  className="border border-term-tiger text-term-tiger px-5 py-2 text-xs font-bold uppercase hover:bg-term-tiger/10 disabled:opacity-30 disabled:border-zinc-700 disabled:text-zinc-600"
                >
                  DIRECT
                </button>
                <span className="text-[10px] text-zinc-600 mt-1 px-1">Edit files in-place, no git</span>
              </div>
              <div className="flex flex-col items-start">
                <button
                  onClick={handleLocalGit}
                  disabled={!localRepoPath}
                  className="border border-term-tiger text-term-tiger px-5 py-2 text-xs font-bold uppercase hover:bg-term-tiger/10 disabled:opacity-30 disabled:border-zinc-700 disabled:text-zinc-600"
                >
                  LOCAL GIT
                </button>
                <span className="text-[10px] text-zinc-600 mt-1 px-1">Worktree + local commits</span>
              </div>
              <div className="flex flex-col items-start">
                <button
                  onClick={() => setExpanded("github")}
                  className="border border-term-tiger text-term-tiger px-5 py-2 text-xs font-bold uppercase hover:bg-term-tiger/10"
                >
                  GITHUB
                </button>
                <span className="text-[10px] text-zinc-600 mt-1 px-1">Clone, branch, PR</span>
              </div>
            </div>
            {!localRepoPath && (
              <div className="text-[10px] text-zinc-600">
                Set <span className="font-mono text-zinc-500">LOCAL_REPO_PATH</span> in settings to enable Direct / Local Git
              </div>
            )}
          </div>
        )}

        {expanded === "github" && (
          <div className="space-y-3">
            {/* Current repo indicator */}
            {currentRepo?.owner && currentRepo?.repo && (
              <div className="text-[11px] text-zinc-500">
                Current: <span className="text-zinc-300">{currentRepo.owner}/{currentRepo.repo}</span>
                {currentRepo.url && (
                  <a href={currentRepo.url} target="_blank" rel="noreferrer" className="ml-2 text-term-tiger hover:underline">
                    [{currentRepo.branch ?? "main"}]
                  </a>
                )}
              </div>
            )}

            {/* Repo dropdown + refresh */}
            <div className="flex gap-2">
              <select
                value={selectedFullName}
                onChange={(e) => { userHasSelected.current = true; setSelectedFullName(e.target.value); }}
                disabled={isLoadingRepos || githubRepos.length === 0}
                className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none disabled:opacity-50"
              >
                <option value="" disabled>-- SELECT REPOSITORY --</option>
                {githubRepos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
              {onRefreshRepos && (
                <button
                  onClick={onRefreshRepos}
                  disabled={isLoadingRepos}
                  className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50 flex items-center gap-1 shrink-0"
                >
                  {isLoadingRepos && <BrailleSpinner variant="sort" width={6} className="[color:inherit]" />}
                  {isLoadingRepos ? "..." : "REFRESH"}
                </button>
              )}
            </div>

            {/* Selected repo info */}
            {selectedRepo && (
              <div className="text-[11px] text-zinc-500 space-y-0.5">
                <div>
                  <span className="text-zinc-600">branch:</span>{" "}
                  <span className="text-zinc-400">{selectedRepo.defaultBranch}</span>
                  {selectedRepo.private && <span className="ml-2 text-yellow-600">[private]</span>}
                </div>
              </div>
            )}

            {/* Create new repo toggle */}
            {!showCreate ? (
              <button
                onClick={() => {
                  setShowCreate(true);
                  if (currentRepo?.owner) setCreateOwner(currentRepo.owner);
                }}
                className="text-[11px] text-zinc-600 hover:text-zinc-400 uppercase"
              >
                + create new repository
              </button>
            ) : (
              <div className="border border-term-border p-2 space-y-2">
                <div className="text-[11px] text-zinc-500 uppercase">Create New Repository</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={createOwner}
                    onChange={(e) => setCreateOwner(e.target.value)}
                    placeholder="owner"
                    className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                  />
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="repo-name"
                    className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                  />
                  <button
                    onClick={handleCreateRepo}
                    disabled={isCreatingRepo || !createOwner.trim() || !createName.trim()}
                    className="border border-term-border hover:bg-term-fg hover:text-black px-3 py-1 text-xs uppercase transition-colors disabled:opacity-50 flex items-center gap-1 shrink-0"
                  >
                    {isCreatingRepo && <BrailleSpinner variant="pendulum" width={6} className="[color:inherit]" />}
                    {isCreatingRepo ? "..." : "CREATE"}
                  </button>
                </div>
                <button
                  onClick={() => setShowCreate(false)}
                  className="text-[11px] text-zinc-600 hover:text-zinc-400"
                >
                  cancel
                </button>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleGitStart}
                disabled={!selectedFullName}
                className="bg-term-tiger text-black px-5 py-2 text-xs font-bold uppercase hover:opacity-90 disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                START EXECUTION
              </button>
              <button
                onClick={() => setExpanded(null)}
                className="border border-zinc-700 text-zinc-400 px-4 py-2 text-xs uppercase hover:text-zinc-200 hover:border-zinc-500"
              >
                BACK
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
