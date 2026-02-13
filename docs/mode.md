# Operating Modes

openTiger behavior is controlled by repository mode, judge mode, and execution environment.

Related:

- `docs/config.md`
- `docs/startup-patterns.md`
- `docs/execution-mode.md`

## 1. Repository Mode (`REPO_MODE`)

### `git`

- clone/push/PR workflow
- judge primarily reviews PR artifacts

Required:

- `REPO_URL`
- `BASE_BRANCH`
- `GITHUB_AUTH_MODE` (`gh` or `token`, default: `gh`)
- `GITHUB_OWNER`
- `GITHUB_REPO`

Notes:

- If `GITHUB_AUTH_MODE=gh`, authenticate with GitHub CLI (`gh auth login`).
- If `GITHUB_AUTH_MODE=token`, set `GITHUB_TOKEN`.

### `local`

- local repository + worktree workflow
- no remote PR creation required

Required:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. Judge Mode (`JUDGE_MODE`)

- `git`: force PR review path
- `local`: force local diff path
- `auto`: follow repository mode

Note:

- `JUDGE_MODE` is env-driven (runtime option), not a `system_config` DB key.

Important flags:

- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`

## 3. Execution Environment and Launch Mode

User-facing key is `EXECUTION_ENVIRONMENT` (`system_config`).

Internal launch mode is derived as:

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

For runtime details (Docker image/network, sandbox auth, and troubleshooting), see `docs/execution-mode.md`.

`LAUNCH_MODE` is runtime internal and normally does not need direct manual configuration.

### `process` (host)

- resident agents consume queue jobs
- fastest recovery and operational visibility

### `docker` (sandbox)

- per-task container isolation
- useful in stricter isolation environments

## 4. Scaling Rules

- planner is hard-limited to one process by API/system logic
- worker/tester/docser/judge counts are configurable
- dispatcher slot control counts only busy executable roles (`worker/tester/docser`)

## 5. Startup Behavior You Should Expect

`/system/preflight` can intentionally skip planner.

Typical:

- issue backlog exists -> create/continue issue tasks first
- open PR or awaiting judge backlog exists -> judge first
- planner starts only when backlog is clear and requirement content exists

## 6. Retry/Recovery Controls

Main knobs:

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT` (`-1` means unlimited global retry budget)
- `DISPATCH_RETRY_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART*`

Queue/lock recovery knobs:

- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

## 7. Quota Operation Settings

- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`

Current task-level behavior still uses `blocked(quota_wait)` + cycle cooldown requeue for convergence.
