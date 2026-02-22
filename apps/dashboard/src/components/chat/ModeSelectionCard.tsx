import React, { useEffect, useState } from "react";
import type { GitHubRepoListItem } from "../../lib/api";
import { BrailleSpinner } from "../BrailleSpinner";

export interface ModeSelectionStartConfig {
  mode: "local" | "git";
  githubOwner?: string;
  githubRepo?: string;
  baseBranch?: string;
}

interface ModeSelectionCardProps {
  onStartExecution?: (config: ModeSelectionStartConfig) => void;
  /** Current configured repo from global config */
  currentRepo?: { owner: string; repo: string; url?: string; branch?: string } | null;
  /** GitHub repos from API */
  githubRepos?: GitHubRepoListItem[];
  isLoadingRepos?: boolean;
  onRefreshRepos?: () => void;
  onCreateRepo?: (owner: string, repo: string) => Promise<void>;
  isCreatingRepo?: boolean;
}

export const ModeSelectionCard: React.FC<ModeSelectionCardProps> = ({
  onStartExecution,
  currentRepo,
  githubRepos = [],
  isLoadingRepos,
  onRefreshRepos,
  onCreateRepo,
  isCreatingRepo,
}) => {
  const [expanded, setExpanded] = useState<"git" | null>(null);
  const [selectedFullName, setSelectedFullName] = useState("");
  const [createOwner, setCreateOwner] = useState("");
  const [createName, setCreateName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [started, setStarted] = useState(false);

  // Auto-select: current configured repo > first in list
  useEffect(() => {
    if (currentRepo?.owner && currentRepo?.repo) {
      const configFullName = `${currentRepo.owner}/${currentRepo.repo}`;
      if (githubRepos.some((r) => r.fullName === configFullName)) {
        // Always sync with config (covers create-new updating config)
        if (selectedFullName !== configFullName) {
          setSelectedFullName(configFullName);
        }
        return;
      }
    }
    // If current selection is valid, keep it
    if (selectedFullName && githubRepos.some((r) => r.fullName === selectedFullName)) {
      return;
    }
    // Otherwise pick first available
    if (githubRepos.length > 0 && githubRepos[0]) {
      setSelectedFullName(githubRepos[0].fullName);
    }
  }, [currentRepo, githubRepos, selectedFullName]);

  const selectedRepo = githubRepos.find((r) => r.fullName === selectedFullName);

  const handleLocal = () => {
    if (!onStartExecution || started) return;
    setStarted(true);
    onStartExecution({ mode: "local" });
  };

  const handleGitStart = () => {
    if (!onStartExecution || started || !selectedRepo) return;
    setStarted(true);
    onStartExecution({
      mode: "git",
      githubOwner: selectedRepo.owner,
      githubRepo: selectedRepo.name,
      baseBranch: selectedRepo.defaultBranch || "main",
    });
  };

  const handleCreateRepo = async () => {
    if (!onCreateRepo || !createOwner.trim() || !createName.trim()) return;
    const owner = createOwner.trim();
    const name = createName.trim();
    await onCreateRepo(owner, name);
    // After creation succeeds, select the new repo and close create form
    const newFullName = `${owner}/${name}`;
    setSelectedFullName(newFullName);
    setShowCreate(false);
  };

  if (started) {
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
          <div className="flex gap-3">
            <button
              onClick={handleLocal}
              className="bg-term-tiger text-black px-5 py-2 text-xs font-bold uppercase hover:opacity-90"
            >
              LOCAL MODE
            </button>
            <button
              onClick={() => setExpanded("git")}
              className="border border-term-tiger text-term-tiger px-5 py-2 text-xs font-bold uppercase hover:bg-term-tiger/10"
            >
              GIT MODE
            </button>
          </div>
        )}

        {expanded === "git" && (
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
                onChange={(e) => setSelectedFullName(e.target.value)}
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
                disabled={!selectedRepo}
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
