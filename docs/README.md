# Docs Index

This folder documents openTiger behavior and operations.

## Architecture and Operations

- `docs/flow.md`
  - End-to-end lifecycle, state transitions, and recovery loops.
- `docs/startup-patterns.md`
  - Start-time decision matrix, exhaustive pattern classes, and runtime state diagram.
- `docs/mode.md`
  - `REPO_MODE`, `JUDGE_MODE`, `LAUNCH_MODE`, scaling, and startup behavior.
- `docs/execution-mode.md`
  - `EXECUTION_ENVIRONMENT` behavior, sandbox runtime details, and Claude auth in Docker.
- `docs/config.md`
  - `/system` APIs and `system_config` setting reference.
- `docs/nonhumanoriented.md`
  - Design principles for long-running autonomous operation.
- `docs/idea.md`
  - Next-phase improvements.

## Agent Specs

- `docs/agent/planner.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`

## Recommended Reading Order

1. `docs/flow.md`
2. `docs/mode.md`
3. `docs/execution-mode.md`
4. `docs/config.md`
5. `docs/agent/*.md`
6. `docs/startup-patterns.md`
7. `docs/idea.md`
