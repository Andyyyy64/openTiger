# 🐯openTiger — Autonomous dev orchestration that never stops

<p align="center">
  <img src="assets/avatar.png" alt="openTiger" width="500" />
</p>

openTiger continuously runs:

1. requirement/issue ingestion
2. task planning and dispatch
3. implementation/testing/documentation updates
4. review/judgement
5. recovery/retry/rework

all under explicit runtime state transitions.

<p align="center">
  <img src="assets/ui.png" alt="openTiger UI" width="720" />
</p>

## Key Features

- Requirement -> executable task generation
- Role-based execution (`worker` / `tester` / `docser`)
- PR and local-worktree judgement (`judge`)
- Query-driven TigerResearch (`planner-first` claim/evidence convergence)
- Recovery-first operation (`quota_wait`, `awaiting_judge`, `needs_rework`)
- Backlog-first startup (Issue/PR backlog is processed before new planning)
- Dashboard + API for process control, logs, and system config
- Runtime switch between host process and docker sandbox execution

## Architecture Overview

- **API (`@openTiger/api`)**: system/config/control endpoints and dashboard backend
- **Planner**: generates tasks from requirements/issues
- **Dispatcher**: leases and dispatches queued tasks
- **Worker/Tester/Docser**: executes task changes and verification
- **Judge**: evaluates successful runs and drives merge/rework decisions
- **Cycle Manager**: convergence loop, cleanup, retry, and replan trigger
- **PostgreSQL + Redis**: persistent state + queueing

See `docs/architecture.md` for component-level details.
See `docs/research.md` for TigerResearch design and operation.

## Prerequisites

- Node.js `>=20`
- pnpm `9.x`
- Docker (for local DB/Redis and sandbox execution mode)

## Installation

### Recommended (bootstrap script)

```bash
curl -fsSL https://opentiger.dev/install.sh | bash
```

### Manual (clone and setup)

```bash
git clone git@github.com:Andyyyy64/openTiger.git
cd openTiger
pnpm run setup
```

## Quick Start

```bash
pnpm run up
```

`pnpm run up` performs:

- monorepo build
- `postgres` / `redis` startup via docker compose
- DB schema push
- runtime hatch disarm
- DB config export to `.env`
- API + Dashboard dev startup

## First-Time Checklist

1. Authenticate GitHub CLI (default auth mode):

   ```bash
   gh auth login
   ```

2. If using Claude Code executor, authenticate on the host:

   ```bash
   claude /login
   ```

3. If using Codex executor, authenticate on the host (or set `OPENAI_API_KEY` / `CODEX_API_KEY`):

   ```bash
   codex login
   ```

4. Open the Dashboard:
   - Dashboard: `http://localhost:5190`
   - API: `http://localhost:4301`
5. Enter requirement on the Start page and run
   - default canonical requirement path: `docs/requirement.md`
6. Monitor progress:
   - `tasks`
   - `runs`
   - `judgements`
   - `logs`
7. (Optional) Run TigerResearch from the `research` page:
   - submit query -> planner decomposition -> parallel collect/challenge/write -> report
   - details: `docs/research.md`
7. If state becomes stalled:
   - Start with initial diagnosis in `docs/state-model.md`
   - Check detailed runbook in `docs/operations.md`

### Common Lookup Guide (state vocabulary -> transition -> owner -> implementation)

- If issues found via API:
  - `docs/api-reference.md` "2.2 API-based lookup (state vocabulary -> transition -> owner -> implementation)"
- To trace transitions from state vocabulary:
  - `docs/state-model.md` -> `docs/flow.md`
- To trace to owning agent and implementation files:
  - `docs/agent/README.md` "Shortest route for implementation tracing"

## Startup and Runtime Behavior

- Planner is started only when backlog gates are clear.
- Existing local/Issue/PR backlog is always prioritized.
- Runtime hatch disarm keeps process self-heal from auto-starting workers/judge only because backlog exists.
- Runtime convergence order:
  - `local backlog > 0`: continue execution
  - `local backlog == 0`: sync Issue backlog via preflight
  - `Issue backlog == 0`: evaluate planner replan

Details: `docs/startup-patterns.md`, `docs/flow.md`

## Documentation Map

First check the index by use case:

- `docs/README.md`
  - includes reader lanes (first-time/operations/implementation tracing)

Recommended order for onboarding:

- `docs/getting-started.md`
- `docs/architecture.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/operations.md`
- `docs/api-reference.md` "2.2 API-based lookup (state vocabulary -> transition -> owner -> implementation)"

Runtime behavior reference:

- `docs/state-model.md`
- `docs/flow.md`
- `docs/startup-patterns.md`
- `docs/mode.md`
- `docs/execution-mode.md`
- `docs/policy-recovery.md`
- `docs/verification.md`
- `docs/research.md`

Agent specification reference:

- `docs/agent/README.md` (role comparison)
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

Design principles:

- `docs/nonhumanoriented.md`

## Authentication and Access Control Notes

- API authentication middleware supports:
  - `X-API-Key` (`API_KEYS`)
  - `Authorization: Bearer <token>` (`API_SECRET` or custom validator)
- `/health` and GitHub webhook endpoint (`/webhook/github`, `/api/webhook/github` when using API prefix) are auth-skipped.
- System-control (`/system/*`, `POST /logs/clear`) access is checked by `canControlSystem()`:
  - `api-key` / `bearer`: always allowed
  - local insecure fallback: allowed unless `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL=false`

## OSS Scope

openTiger is optimized for long-running autonomous repository workflows with explicit recovery paths.  
It does **not** guarantee one-shot success under all external conditions, but it is designed to avoid silent stalls and continuously converge by switching recovery strategy.
