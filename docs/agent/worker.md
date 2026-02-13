# Worker Agent Specification

Related:

- `docs/agent/README.md`
- `docs/policy-recovery.md`
- `docs/verification.md`

## 1. Role

Worker runtime switches execution mode based on `AGENT_ROLE`:

- `worker`: implementation changes
- `tester`: test-centric changes
- `docser`: documentation changes

This page describes **shared behavior** of the Worker runtime.  
For Tester/Docser-specific differences, see:

- `docs/agent/tester.md`
- `docs/agent/docser.md`

Out of scope:

- Overall backlog replan decisions
- PR approve/rework decisions

## 2. Standard Execution Flow

1. Acquire runtime lock
2. Checkout / branch prep
3. LLM execution (`claude_code` / `codex` / `opencode`)
4. Expected-file verification
5. Run verification phase
6. Commit/push + PR creation (git mode)
7. Update run/task/artifact
8. Release lease and return agent to idle

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

- Review required -> `blocked(awaiting_judge)`
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
- `|`, `&&`, `||`, `;`, `<`, `>`, `` ` ``

## 7. Implementation Reference (Source of Truth)

- Startup and role resolution: `apps/worker/src/main.ts`
- Execution body: `apps/worker/src/worker-runner.ts`
- Verification phase: `apps/worker/src/worker-runner-verification.ts`
- Role-specific helper behavior: `apps/worker/src/worker-task-helpers.ts`
- Runtime lock: `apps/worker/src/worker-runtime-lock.ts`
- Verification command handling: `apps/worker/src/steps/verify/`
- Research runner: `apps/worker/src/research/runner.ts`
- Research prompt/persistence: `apps/worker/src/research/prompt.ts`, `apps/worker/src/research/persist.ts`

## 8. Main Configuration

- `AGENT_ID`, `AGENT_ROLE`
- `LLM_EXECUTOR` (`claude_code` / `codex` / `opencode`)
- `WORKER_MODEL`, `TESTER_MODEL`, `DOCSER_MODEL`
- `CLAUDE_CODE_*`, `CODEX_*`, `OPENCODE_*`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
