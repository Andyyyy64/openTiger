import React, { useState } from "react";

interface RepoPromptCardProps {
  onConfigure?: (config: {
    repoMode: string;
    githubOwner: string;
    githubRepo: string;
    baseBranch: string;
  }) => void;
}

export const RepoPromptCard: React.FC<RepoPromptCardProps> = ({ onConfigure }) => {
  const [repoMode, setRepoMode] = useState("github");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");

  const handleSubmit = () => {
    if (onConfigure) {
      onConfigure({
        repoMode,
        githubOwner: owner.trim(),
        githubRepo: repo.trim(),
        baseBranch: branch.trim() || "main",
      });
    }
  };

  const handleSkip = () => {
    if (onConfigure) {
      onConfigure({
        repoMode: "local-git",
        githubOwner: "",
        githubRepo: "",
        baseBranch: "main",
      });
    }
  };

  return (
    <div className="py-2 px-3">
      <div className="border border-zinc-700 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-zinc-400 text-xs font-bold uppercase tracking-wider">
            REPOSITORY CONFIGURATION
          </span>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-zinc-500 text-xs w-20 shrink-0">MODE</label>
            <select
              value={repoMode}
              onChange={(e) => setRepoMode(e.target.value)}
              className="bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none"
            >
              <option value="github">GitHub</option>
              <option value="local-git">Local Git</option>
              <option value="direct">Direct</option>
            </select>
          </div>

          {repoMode === "github" && (
            <>
              <div className="flex items-center gap-3">
                <label className="text-zinc-500 text-xs w-20 shrink-0">OWNER</label>
                <input
                  type="text"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="github-owner"
                  className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-zinc-500 text-xs w-20 shrink-0">REPO</label>
                <input
                  type="text"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="repository-name"
                  className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-zinc-500 text-xs w-20 shrink-0">BRANCH</label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="flex-1 bg-black border border-term-border px-2 py-1 text-xs text-term-fg focus:border-term-tiger focus:outline-none placeholder-zinc-700"
                />
              </div>
            </>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={handleSubmit}
              disabled={repoMode === "github" && (!owner.trim() || !repo.trim())}
              className="bg-term-tiger text-black px-4 py-1.5 text-xs font-bold uppercase hover:opacity-90 disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              CONFIGURE
            </button>
            <button
              onClick={handleSkip}
              className="border border-zinc-700 text-zinc-400 px-4 py-1.5 text-xs uppercase hover:text-zinc-200 hover:border-zinc-500"
            >
              SKIP (LOCAL MODE)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
