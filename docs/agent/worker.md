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
3. LLM execution (`opencode` or `claude_code`)
4. Expected-file verification
5. Run verification phase
6. Commit/push + PR creation (git mode)
7. Update run/task/artifact
8. Release lease and return agent to idle

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

## 8. Main Configuration

- `AGENT_ID`, `AGENT_ROLE`
- `WORKER_MODEL`, `TESTER_MODEL`, `DOCSER_MODEL`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
