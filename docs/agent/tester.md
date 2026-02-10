# Tester Agent

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
- e2e command can be auto-appended when tester tasks explicitly require e2e coverage

## 5. Important Settings

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- project-specific e2e command in repository scripts
