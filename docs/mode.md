# Operation Modes

openTiger behavior is controlled by the combination of repository mode / judge mode / execution environment.

Related:

- [config](config.md)
- [state-model](state-model.md)
- [flow](flow.md)
- [operations](operations.md)
- [startup-patterns](startup-patterns.md)
- [execution-mode](execution-mode.md)
- [agent/dispatcher](agent/dispatcher.md)
- [agent/judge](agent/judge.md)

### Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, When Entering from Mode Config)

When tracing stalls from mode config, check in order: state vocabulary -> transition -> owner -> implementation.

1. [state-model](state-model.md) (state vocabulary)
2. [flow](flow.md) (transitions and recovery paths)
3. [operations](operations.md) (API procedures and operation shortcuts)
4. [agent/README](agent/README.md) (owning agent and implementation tracing path)

## 1. Repository Mode (`REPO_MODE`)

### `git`

- Clone/push/PR-based operation
- Judge mainly evaluates PR artifacts

Required config:

- `REPO_URL`
- `BASE_BRANCH`
- `GITHUB_AUTH_MODE` (`gh` or `token`; default: `gh`)
- `GITHUB_OWNER`
- `GITHUB_REPO`

Note:

- With `GITHUB_AUTH_MODE=gh`, authenticate via GitHub CLI (`gh auth login`)
- With `GITHUB_AUTH_MODE=token`, set `GITHUB_TOKEN`

### `local`

- Local repository + worktree-based operation
- No remote PR creation

Required config:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. Judge Mode (`JUDGE_MODE`)

- `git`: force PR review path
- `local`: force local diff path
- `auto`: follow repository mode

Note:

- `JUDGE_MODE` is a runtime option from env, not a `system_config` DB key.

Main flags:

- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`

## 3. Execution Environment and Launch Mode

User-facing key is `EXECUTION_ENVIRONMENT` (in `system_config`).

Internal launch mode is derived as:

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

For runtime details (Docker image/network, sandbox auth, troubleshooting), see [execution-mode](execution-mode.md).

`LAUNCH_MODE` is internal; you normally don't set it directly.

### `process` (host)

- Resident agents consume queue jobs
- Prioritizes recovery speed and operational visibility

### `docker` (sandbox)

- Per-task container isolation
- Useful when isolation requirements are strict

LLM executor selection is controlled by `LLM_EXECUTOR` (default) plus optional role overrides:

- `WORKER_LLM_EXECUTOR`
- `TESTER_LLM_EXECUTOR`
- `DOCSER_LLM_EXECUTOR`
- `JUDGE_LLM_EXECUTOR`
- `PLANNER_LLM_EXECUTOR`

Each role override supports `inherit` to follow `LLM_EXECUTOR`.

Available executor values:

- `claude_code`
- `codex`
- `opencode`

Fallback behavior:

- If an override is unset, empty, or `inherit`, that role follows `LLM_EXECUTOR`.
- If `LLM_EXECUTOR` is unset or unrecognized, runtime resolution falls back to `codex`.

## 4. Scaling Rules

- Planner is fixed at 1 process by API/system logic
- worker/tester/docser/judge counts are configurable
- Dispatcher slot control counts only busy execution roles (`worker`/`tester`/`docser`)

Implementation responsibility:

- Slot control/dispatch: [agent/dispatcher](agent/dispatcher.md)
- Approve/rework decisions: [agent/judge](agent/judge.md)

## 5. Expected Startup Behavior

`/system/preflight` may intentionally skip planner.

Examples:

- Issue backlog exists -> create/continue issue tasks first
- Open PR or `awaiting_judge` backlog exists -> start Judge first
- Planner starts only when backlog is cleared and requirement exists

## 6. Retry / Recovery Control

Main knobs:

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT` (`-1` = global retry budget unlimited)
- `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD` (default: `4`)
- `DISPATCH_RETRY_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART*`

Classification note:

- Retry and recovery classification prefers `runs.error_meta.failureCode`.
- Legacy runs without `error_meta` still use message fallback to keep compatibility.

Queue/lock recovery knobs:

- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

## 7. Quota Operation Config

- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`

Current task-level behavior converges via `blocked(quota_wait)` and cycle cooldown requeue.
