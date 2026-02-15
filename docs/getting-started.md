# Getting Started

This guide provides the shortest path from first run to starting autonomous execution.

Quick install (recommended):

```bash
curl -fsSL https://opentiger.dev/install.sh | bash
```

Related:

- [docs/architecture.md](docs/architecture.md)
- [docs/config.md](docs/config.md)
- [docs/api-reference.md](docs/api-reference.md)
- [docs/operations.md](docs/operations.md)
- [docs/agent/README.md](docs/agent/README.md)
- [docs/research.md](docs/research.md)

## 1. Prerequisites

- Node.js `>=22.12`
- pnpm `9.x`
- Docker
- GitHub CLI (`gh`) recommended

Claude Code executor requires the `claude` CLI.
Codex executor requires the `codex` CLI.

## 2. Setup

```bash
pnpm run setup
```

## 3. Authentication (First Time Only)

### GitHub Integration

Default is `GITHUB_AUTH_MODE=gh`.

```bash
gh auth login
```

For token mode, set `GITHUB_TOKEN` in System Config.

### When Using `LLM_EXECUTOR=claude_code`

```bash
claude /login
```

### When Using `LLM_EXECUTOR=codex`

```bash
codex login
```

## 4. Startup

```bash
pnpm run up
```

This command:

- Builds
- Starts `postgres` / `redis`
- Pushes DB schema
- Disarms runtime hatch
- Exports DB config to `.env`
- Starts API/Dashboard

## 5. Access Dashboard

- Dashboard: `http://localhost:5190`
- API: `http://localhost:4301`

## 6. Start First Execution on Start Page

1. Enter requirement
2. Run `EXECUTE RUN`
3. Start processes per preflight recommendation

Important:

- With backlog (Issue/PR/local tasks), Planner is intentionally skipped
- Planner starts only when backlog is empty

## 7. Monitor Progress

- `tasks`: task state
- `runs`: execution results and logs
- `judgements`: Judge evaluations
- `logs`: aggregated process logs

## 8. First 5-Minute Check After Startup

These checks help detect initial misconfig quickly:

1. Processes are running
   - Confirm `dispatcher` / `cycle-manager` / `worker-*` / `judge-*` via `GET /system/processes`
2. Agents are registered
   - Confirm `idle`/`busy` agents via `GET /agents`
3. Tasks are transitioning
   - Confirm `queued` doesn't stay fixed; moves to `running` or `blocked`/`done`
4. Runs are not failing repeatedly
   - Confirm no consecutive `failed` with same error via `GET /runs`
5. No startup errors in logs
   - Confirm no auth/connection/config errors in `GET /logs/all`

For detailed operation checks, see `docs/operations.md`.  
For state transitions that stall, start with the initial diagnosis table in `docs/state-model.md`.

### 8.1 Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, for First-Time Users)

First-time users can triage by:

1. Confirm state vocabulary
   - `docs/state-model.md` (7)
2. Check where it stalls via transitions
   - `docs/flow.md` (relevant section)
3. Run API check sequence
   - `docs/operations.md` (11)
4. Identify owning agent and implementation
   - `docs/agent/README.md` (FAQ and implementation tracing path)
5. Use API-based lookup when tracing from API
   - `docs/api-reference.md` (2.2)

## 9. Common Initial Issues

### Repository Not Configured (GitHub)

- Select existing repo or create new one from Start page repo manager
- For `REPO_MODE=git`, need `REPO_URL` and `GITHUB_OWNER/REPO`

### Handling Claude Auth Warning

- Host execution: rerun `claude /login`
- Sandbox execution: confirm host auth dir is mounted

### Handling Codex Auth Warning

- Host execution: rerun `codex login` or set `OPENAI_API_KEY` / `CODEX_API_KEY`
- Sandbox execution: confirm host `~/.codex` is mounted

### Planner Not Starting (Preflight)

- Normal behavior with backlog priority
- Becomes replan target when Issue/PR/local backlog is cleared

## 10. First TigerResearch Run (Optional)

1. Open Dashboard `plugins` page and select `tiger-research`
2. Submit a query via `CREATE_JOB`
3. Confirm planner-first kickoff:
   - `GET /plugins/tiger-research/jobs`
   - `GET /system/processes` (planner/dispatcher/cycle-manager/worker)
4. Open job detail and confirm:
   - claims are created
   - `collect` tasks are queued/running in parallel
5. Track convergence:
   - evidence growth, report creation, judge/rework transitions

If runs keep getting `cancelled` with "Agent process restarted before task completion":

- Check API dev restart behavior and `OPENTIGER_PRESERVE_MANAGED_ON_DEV_SIGTERM`
- See `docs/research.md` and `docs/operations.md`
