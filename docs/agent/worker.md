# Worker Agent Specification

Related:

- [README](README.md)
- [policy-recovery](../policy-recovery.md)
- [verification](../verification.md)

## 1. Role

Worker runtime switches execution mode based on `AGENT_ROLE`:

- `worker`: implementation changes
- `tester`: test-centric changes
- `docser`: documentation changes

This page describes **shared behavior** of the Worker runtime.  
For Tester/Docser-specific differences, see:

- [tester](tester.md)
- [docser](docser.md)

Out of scope:

- Overall backlog replan decisions
- PR approve/rework decisions

## 2. Standard Execution Flow

### github / local-git mode

1. Acquire runtime lock
2. Checkout / branch prep
3. LLM execution (`opencode`, `claude_code`, or `codex`)
4. Expected-file verification
5. Run verification phase
6. Commit/push + PR creation (github mode) or local diff (local-git mode)
7. Update run/task/artifact
8. Release lease and return agent to idle

### direct mode

1. Acquire runtime lock
2. Snapshot pre-execution filesystem state (mtime + size)
3. LLM execution (writes directly to `LOCAL_REPO_PATH`)
4. Snapshot post-execution filesystem state
5. Compute diff (changed/added/removed files via snapshot comparison)
6. Run verification commands (spawn-safe, `&&` chains expanded)
7. Create `direct_edit` artifact with change summary
8. Task transitions directly to `done` (no judge review)
9. Release lease and return agent to idle

Research flow (`task.kind=research`):

1. Acquire runtime lock
2. Build research input from `task.context.research`
3. Load claim/evidence snapshot
4. Run research prompt execution (non-git path)
5. Persist claims/evidence/report artifacts
6. Update run/task state (`done` or `blocked(awaiting_judge)` for write stage when judge required)
7. Release lease/runtime lock

## 3. Verification Phase

The verification phase includes multiple recovery steps, not just simple command execution.

- Execute explicit commands
- Retry on no-change failure
- No-op detection (pass assumed when verification passes)
- Deterministic policy violation recovery
- Optional LLM policy recovery (`allow|discard|deny`)
- Discard + learn generated artifacts
- Verification recovery (retry around failed commands)

When unresolvable:

- policy/verification failure -> `blocked(needs_rework)`

## 4. State Transitions

Success:

- `github`/`local-git` mode with review required -> `blocked(awaiting_judge)`
- `direct` mode -> `done` (always, no judge review)
- No review required -> `done`

Failure:

- Quota-related -> `blocked(quota_wait)`
- Verification/policy -> `blocked(needs_rework)`
- Other -> `failed`

Research-specific notes:

- `plan/collect/challenge/write` stages run without checkout/branch/commit/pr
- Search is model-tool-driven; no dedicated external search provider integration is required

## 5. Safety and Guardrails

- Pre-check for denied commands
- Commands containing shell operators are excluded from execution
- Runtime lock + queue guard prevent duplicate execution
- Expected-file mismatch reflected as warning/failure

## 6. Verification Command Constraints

Commands are executed via spawn, not shell. The following are not supported:

- `$()`
- `|`, `||`, `;`, `<`, `>`, `` ` ``

Notes:

- `&&` is supported only as a verification-chain splitter.
- `cd <path> && <command>` is handled as cwd transition plus command execution.
- Shell builtins such as `source` / `export` are not directly executable and are treated as verification format/setup failure.

## 7. Implementation Reference (Source of Truth)

- Startup entrypoint and role resolution: `apps/worker/src/start.ts`, `apps/worker/src/main.ts`
- Execution body: `apps/worker/src/worker-runner.ts` (github/local-git), `apps/worker/src/worker-runner-direct.ts` (direct)
- Verification phase: `apps/worker/src/worker-runner-verification.ts`
- Role-specific helper behavior: `apps/worker/src/worker-task-helpers.ts`
- Runtime lock: `apps/worker/src/worker-runtime-lock.ts`
- Verification command handling: `apps/worker/src/steps/verify/`
- Research runner: `apps/worker/src/research/runner.ts`
- Research prompt/persistence: `apps/worker/src/research/prompt.ts`, `apps/worker/src/research/persist.ts`

## 8. Main Configuration

- `AGENT_ID`, `AGENT_ROLE`
- `WORKER_MODEL`, `TESTER_MODEL`, `DOCSER_MODEL`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_NO_CHANGE_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT`
- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT`
- `WORKER_VERIFY_SKIP_INVALID_AUTO_COMMAND`
- `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS`
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY`
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY_CANDIDATES`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
