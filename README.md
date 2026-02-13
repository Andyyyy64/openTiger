# 🐯openTiger — Never-stopping autonomous development orchestration

<p align="center">
  <img src="assets/avatar.png" alt="openTiger" width="500" />
</p>

openTiger continuously runs requirement-to-task generation, implementation, review, and recovery using multiple agents.

<p align="center">
  <img src="assets/ui.png" alt="openTiger UI" width="720" />
</p>

## What It Can Do

- Generate executable tasks from requirements
- Run implementation in parallel with Worker / Tester / Docser roles
- Review with Judge and apply auto-merge decisions
- Self-recover on failure (retry, rework, re-evaluate)
- Monitor tasks, runs, and agents from one dashboard
- Switch execution runtime between host and sandbox from dashboard `system`

## What Makes It Different

- Prioritizes “do not stall” over first-attempt perfection
- Does not claim guaranteed completion; it keeps running and switches recovery strategy when progress patterns degrade
- Backlog-first startup
  - Existing issues/PRs are processed before generating new plans
- Strict convergence loop in runtime
  - `local tasks -> issue backlog sync -> planner replan (only when issue backlog is empty)`
- Explicit blocked states in runtime
  - `awaiting_judge` / `quota_wait` / `needs_rework` / `issue_linking`
- Duplicate-execution defenses
  - lease, runtime lock, and judge idempotency
- Planner is single-instance; execution agents can scale horizontally

## Install

Runtime: Node `>=20`, pnpm `9.x`, Docker.

No manual `.env` setup is required for first boot.

Preferred setup (one-command bootstrap):

```bash
curl -fsSL https://raw.githubusercontent.com/Andyyyy64/openTiger/main/scripts/install.sh | bash
```

Alternative (pnpm, no git history):

```bash
pnpm dlx degit Andyyyy64/openTiger openTiger
cd openTiger
pnpm run setup
```

Alternative (git clone over SSH):

```bash
git clone git@github.com:Andyyyy64/openTiger.git
cd openTiger
pnpm run setup
```

GitHub authentication defaults to `gh` mode.

- Recommended: install GitHub CLI
- Optional: set `GITHUB_AUTH_MODE=token` and provide `GITHUB_TOKEN`

## Quick Start

```bash
pnpm run up
```

## Access

- Dashboard: `http://localhost:5190`
- API: `http://localhost:4301`

## First Run Flow

1. Complete `gh auth login` and `claude /login` on the host
2. Run `pnpm run up` and open Dashboard `system`
3. Start planner with your requirement content (default path: `docs/requirement.md`)
4. Monitor progress in `tasks`, `runs`, and `judgements`

## Best For Teams That

- Need to keep processing even with large issue/PR backlogs
- Want to reduce manual babysitting of autonomous coding loops
- Prefer recovery-first workflows over stop-on-error behavior

## Documentation

- `docs/flow.md`: end-to-end state transitions and convergence flow
- `docs/startup-patterns.md`: startup decision matrix and pattern classes
- `docs/mode.md`: operating modes and scaling setup
- `docs/execution-mode.md`: host/sandbox execution behavior and sandbox auth details
- `docs/config.md`: `/system` and `system_config` settings guide
- `docs/policy-recovery.md`: in-run policy self-recovery and allowedPaths self-growth
- `docs/nonhumanoriented.md`: “never stall” design principles
- `docs/agent/*.md`: per-agent responsibilities
