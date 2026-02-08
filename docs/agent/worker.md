# Worker Agent

## 1. Role

Execute task implementation and verification.

`AGENT_ROLE` selects behavior family:

- `worker`
- `tester`
- `docser`

## 2. Standard Execution Flow

1. Validate task and acquire runtime lock
2. Checkout/branch preparation
3. OpenCode task execution
4. expected-file check
5. verification command execution
6. commit/push + PR creation (git mode)
7. run/task/artifact updates
8. lease release and agent idle

## 3. Success Transitions

- review required -> `blocked(awaiting_judge)`
- no review required -> `done`

## 4. Failure Transitions

- quota signature -> `blocked(quota_wait)`
- other failures -> `failed`

Both cases:

- run marked `failed`
- lease released
- agent returned to `idle`

## 5. Duplicate Execution Defenses

- per-task runtime lock file
- `activeTaskIds` in queue worker
- startup-window lock conflict skip (avoid false immediate recovery)

## 6. Safety Rules

- denied command checks before OpenCode and verify
- verify avoids long-lived dev/watch flows
- expected-file validation supports `src/` fallback path resolution

## 7. Important Settings

- `AGENT_ID`, `AGENT_ROLE`
- `WORKER_MODEL` / `TESTER_MODEL` / `DOCSER_MODEL`
- `WORKSPACE_PATH`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `OPENTIGER_TASK_LOCK_DIR`
