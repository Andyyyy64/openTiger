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
3. Task execution via selected LLM executor (`opencode` / `claude_code`)
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
- verification/policy failure -> `blocked(needs_rework)`
- other non-recoverable failures -> `failed`

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

## 7. Verification Command Constraints

Verification commands run via `spawn` (no shell), so shell features do not work:

- `$()` command substitution — rejected at parse; if explicit and failed, skipped when remaining commands exist
- `|`, `&&`, `||`, `;`, `<`, `>`, backticks — rejected

When explicit command fails due to unsupported format or missing script, Worker may skip and continue with remaining commands when appropriate (doc-only, no-op, or prior command passed).

## 8. Transient Failure Retry

Checkout, branch creation, stage, push, and branch restore use transient-pattern retry (timeout, connection reset, etc.) before failing. Git add ignores paths that are listed in `.gitignore` and stages the rest instead of failing.

## 9. Important Settings

- `AGENT_ID`, `AGENT_ROLE`
- `WORKER_MODEL` / `TESTER_MODEL` / `DOCSER_MODEL`
- `WORKSPACE_PATH`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `OPENTIGER_TASK_LOCK_DIR`
