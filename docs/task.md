# Implementation Status and Priority Backlog

## 1. Current Milestone

Core infrastructure changes for the goal "never stall, finish in parallel" are complete.

Completed:

- [x] Start preflight
  - Check GitHub open issues/open PRs and local backlog before startup
- [x] Direct issue injection flow
  - Auto-generate tasks directly from open issues instead of going through the planner
- [x] Clarified Judge startup conditions
  - Start Judge when there is an open PR or `awaiting_judge` backlog
- [x] Judge idempotency
  - `runs.judged_at` / `judgement_version`
- [x] Introduced blocked reason
  - `awaiting_judge` / `needs_rework` / `needs_human`
- [x] Automatic blocked resolution
  - Reason-based transitions
- [x] Unified concurrency control
  - Busy-agent based
- [x] Non-destructive verify
  - Removed auto file edits during verify
- [x] Double defense for deniedCommands
  - Before verify + before OpenCode
- [x] Failure classification and adaptive retries
  - `env/setup/policy/test/flaky/model`
- [x] Observability improvements
  - Queue age / blocked age / retry exhaustion

## 2. Remaining Critical Tasks

### 2.1 needs_human operations

- [ ] Implement dedicated queue/status, not just isolation events
- [ ] Allow resume/rollback controls in the Dashboard

### 2.2 Implement health/ready

- [ ] DB connectivity checks
- [ ] Redis connectivity checks
- [ ] Queue connectivity checks

### 2.3 Strengthen integration tests

- [ ] Tests for retry classification logic
- [ ] Tests for blocked reason transitions
- [ ] Race tests for Judge claim (idempotency)

### 2.4 Operations automation

- [ ] Introduce triager role
- [ ] Planner recursive splitting
- [ ] Mechanize docser update rules

## 3. Operational SLO

- [x] Defined
- [ ] Strengthen automatic actions on SLO violations

SLO:

- queued -> running: within 5 minutes
- blocked: handled within 30 minutes
- retry exhaustion: always monitored

## 4. Minimum Release Criteria

- [ ] `pnpm run check` passes consistently
- [ ] E2E passes on core scenarios
- [ ] 24-hour run stays within SLO violation thresholds
