# 🐯openTiger — Never-stopping autonomous development orchestration

<p align="center">
  <img src="assets/avatar.png" alt="openTiger" width="500" />
</p>

openTiger continuously runs:

1. requirement/issue ingestion
2. task planning and dispatch
3. implementation/testing/documentation execution
4. review/judgement
5. recovery/retry/rework

all under explicit runtime state transitions.

<p align="center">
  <img src="assets/ui.png" alt="openTiger UI" width="720" />
</p>

## Core Capabilities

- Requirement -> executable task generation
- Role-based execution (`worker` / `tester` / `docser`)
- PR and local-worktree judgement (`judge`)
- Recovery-first operation (`quota_wait`, `awaiting_judge`, `needs_rework`)
- Backlog-first startup (Issue/PR backlog is processed before new planning)
- Dashboard + API for process control, logs, and system config
- Runtime switch between host process and docker sandbox execution

## Architecture at a Glance

- **API (`@openTiger/api`)**: system/config/control endpoints and dashboard backend
- **Planner**: generates tasks from requirements/issues
- **Dispatcher**: leases and dispatches queued tasks
- **Worker/Tester/Docser**: executes task changes and verification
- **Judge**: evaluates successful runs and drives merge/rework decisions
- **Cycle Manager**: convergence loop, cleanup, retry, and replan trigger
- **PostgreSQL + Redis**: persistent state + queueing

See `docs/architecture.md` for component-level details.

## Requirements

- Node.js `>=20`
- pnpm `9.x`
- Docker (for local DB/Redis and sandbox execution mode)

## Installation

### Preferred (bootstrap script)

```bash
curl -fsSL https://opentiger.dev/install.sh | bash
```

### Alternative (manual clone)

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

## First Run Checklist

1. Authenticate GitHub CLI (default auth mode):

   ```bash
   gh auth login
   ```

2. If using Claude Code executor, authenticate on host:

   ```bash
   claude /login
   ```

3. Open Dashboard:
   - Dashboard: `http://localhost:5190`
   - API: `http://localhost:4301`
4. Open Start page and submit requirement content
   - default canonical requirement path: `docs/requirement.md`
5. Monitor:
   - `tasks`
   - `runs`
   - `judgements`
   - `logs`
6. If states appear stuck:
   - start from `docs/state-model.md` triage patterns
   - then follow `docs/operations.md` for detailed runbook

### 状態詰まりを最短で追う導線

- API で異常を見つけた場合:
  - `docs/api-reference.md` の「2.2 API 起点で状態詰まりを逆引きする導線」
- 状態語彙から遷移を追う場合:
  - `docs/state-model.md` -> `docs/flow.md`
- 担当 agent と実装ファイルまで追う場合:
  - `docs/agent/README.md` の「実装追跡の最短ルート」

## Startup and Runtime Behavior

- Planner is started only when backlog gates are clear.
- Existing local/Issue/PR backlog is always prioritized.
- Runtime convergence order:
  - `local backlog > 0`: continue execution
  - `local backlog == 0`: sync Issue backlog via preflight
  - `Issue backlog == 0`: evaluate planner replan

Details: `docs/startup-patterns.md`, `docs/flow.md`

## Documentation Map

Need a purpose-based index first:

- `docs/README.md`
  - includes reader lanes (first-time / operations / implementation-follow-up)

Start here:

- `docs/getting-started.md`
- `docs/architecture.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/operations.md`
- `docs/api-reference.md` の「2.2 API 起点で状態詰まりを逆引きする導線」

Execution behavior:

- `docs/state-model.md`
- `docs/flow.md`
- `docs/startup-patterns.md`
- `docs/mode.md`
- `docs/execution-mode.md`
- `docs/policy-recovery.md`
- `docs/verification.md`

Agent-level specifications:

- `docs/agent/README.md` (role comparison)
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

Design policy:

- `docs/nonhumanoriented.md`

## Notes on Authentication and Access

- API authentication middleware supports:
  - `X-API-Key` (`API_KEYS`)
  - `Authorization: Bearer <token>` (`API_SECRET` or custom validator)
- `/health` と GitHub webhook endpoint（`/webhook/github`、prefix 構成時は `/api/webhook/github`）は auth-skipped.
- System-control (`/system/*`, `POST /logs/clear`) access is checked by `canControlSystem()`:
  - `api-key` / `bearer`: always allowed
  - local insecure fallback: allowed unless `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL=false`

## OSS Scope

openTiger is optimized for long-running autonomous repository workflows with explicit recovery paths.  
It does **not** guarantee one-shot success under all external conditions, but it is designed to avoid silent stalls and continuously converge by switching recovery strategy.
