# Worker Agent

## 1. Role

Implement tasks and produce artifacts through verification.

The role is determined by `AGENT_ROLE`:

- `worker`
- `tester`
- `docser`

## 2. Execution Flow

1. Create run record
2. Prepare checkout / branch
3. Run OpenCode
4. Run verify
5. commit/push or local commit
6. Create PR (git mode)
7. Update run/task/artifact

## 3. Key Specifications

- Prevent duplicate task execution with a lock
- On run success, transition task to `blocked(awaiting_judge)`
- On run failure, transition task to `failed`
- Store OpenCode token usage in `costTokens`
- Inject hints from past failures into the prompt on retry

## 4. Safety

- Denylisted commands are rejected before OpenCode execution
- Deny checks also run before verify
- Verify is non-destructive (does not mutate repo state)

## 5. Main Settings

- `AGENT_ID`
- `AGENT_ROLE`
- `WORKER_MODEL` / `TESTER_MODEL` / `DOCSER_MODEL`
- `WORKER_INSTRUCTIONS_PATH` / `TESTER_INSTRUCTIONS_PATH` / `DOCSER_INSTRUCTIONS_PATH`
- `WORKSPACE_PATH`
- `REPO_MODE`, `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `OPENTIGER_TASK_LOCK_DIR`

## 6. On Failure

- Save the cause to `runs.errorMessage`
- Transition task to `failed`
- Delegate to Cycle Manager classification-based retries
