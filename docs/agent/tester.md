# Tester Agent

関連:

- `docs/agent/README.md`
- `docs/verification.md`

## 1. Role

Specialized worker for test-oriented tasks.

Uses the same worker runtime with `AGENT_ROLE=tester` and tester-specific instructions/model.

## 2. Typical Responsibilities

- add/fix unit/integration/e2e tests
- stabilize flaky verification commands
- provide reproducible failure context for judge/autofix loops

## 3. Planner/Dispatcher Integration

- planner infers tester role from task text/path hints
- dispatcher routes role-tagged tasks to idle tester agents

## 4. Verification Policy

- non-interactive commands only
- avoid watch-mode commands
- planner/worker verify contract を利用可能
- e2e command は「明示的に e2e 要求がある task」にのみ自動補完される

## 5. Important Settings

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
