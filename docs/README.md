# Docs Index

Index of openTiger design, operations, and agent specifications.

## 1. Overview

- `docs/flow.md`
  - State transitions from requirement generation to implementation, Judge, retries, and cleanup
- `docs/mode.md`
  - Operating modes for `REPO_MODE` / `JUDGE_MODE` / `LAUNCH_MODE`
- `docs/nonhumanoriented.md`
  - Principles and SLOs to minimize human intervention
- `docs/task.md`
  - Implementation status and priority backlog
- `docs/idea.md`
  - Next-phase ideas and extension proposals

## 2. By Agent

- `docs/agent/planner.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`

## 3. Major Updates on 2026-02-06

- Introduced Start preflight
  - Check GitHub open issues/open PRs and local task state before startup
- Automated issue backlog handling
  - Open issues are injected directly as tasks instead of going through the planner
- Clarified Judge startup conditions
  - Start Judge when there is an open PR or `awaiting_judge` backlog
- Judge idempotency
  - Introduced `runs.judged_at` / `judgement_version` to prevent re-reviewing the same run
- Introduced blocked reason
  - Operate with `awaiting_judge` / `needs_rework` / `needs_human`
- Unified concurrency control
  - Dispatcher concurrency now based on busy agent count
- Non-destructive verify
  - Removed auto-fixes to `package.json` during verify
- Double defense for deniedCommands
  - Reject both before verify and before OpenCode execution
- Failure classification and adaptive retries
  - Classify as `env/setup/policy/test/flaky/model` and adjust retry strategy
- Observability improvements
  - Visualize `queued->running 5m` / `blocked 30m` / `retry exhaustion`
