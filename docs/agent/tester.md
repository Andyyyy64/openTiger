# Tester Agent Specification

Related:

- [README](README.md)
- [worker](worker.md)
- [verification](../verification.md)

## 1. Role

Tester is a derived role of the Worker runtime running with `AGENT_ROLE=tester`.  
This page documents only Tester-specific differences.

For shared execution flow, state transitions, and safety constraints, see [worker](worker.md).

## 2. Main Responsibilities

- Add/update unit/integration/e2e tests
- Stabilize flaky verification commands
- Provide reproducible failure context for Judge and autofix loops

## 3. Pre-Dispatch Coordination (Planner/Dispatcher)

- Planner infers tester role from task content and path hints
- Dispatcher assigns role-tagged tasks to idle testers

## 4. Verification Policy

- Only non-interactive commands allowed
- Avoid watch-mode commands
- Can use Planner/Worker verify contract
- e2e commands are auto-added only for tasks that explicitly request e2e

## 5. Main Configuration

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`

For shared settings (retry/policy recovery/verify recovery, etc.), see [worker](worker.md).

## 6. Implementation Reference (Source of Truth)

- Role startup branching: `apps/worker/src/start.ts`, `apps/worker/src/main.ts`
- Role-specific instructions: `apps/worker/instructions/tester.md`
- Verification command auto-completion: `apps/worker/src/steps/verify/repo-scripts.ts`
- Shared execution body: `apps/worker/src/worker-runner.ts`, `apps/worker/src/worker-runner-verification.ts`
