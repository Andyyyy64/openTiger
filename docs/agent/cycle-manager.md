# Cycle Manager Agent Specification

Related:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/operations.md`

## 1. Role

Cycle Manager maintains system-wide convergence for long-running operation.  
It runs monitoring, cleanup, and replanning periodically to support non-stalling operation.

Out of scope:

- Directly modifying individual task implementation content
- PR diff approve/rework decisions

## 2. Runtime Loops

- Monitor loop
  - Cycle end condition evaluation
  - Anomaly detection
  - Cost limit monitoring
  - Issue preflight / replan decision when backlog is depleted
- Cleanup loop
  - Recovery of expired lease / offline agent / stuck run
  - Requeue of failed/blocked tasks after cooldown
- Stats loop
  - Cycle stats and system state updates

Research orchestrator loop:

- Runs in monitor loop (`runResearchOrchestrationTick`)
- Drives `planning/collecting/challenging/composing/judging/reworking`
- Queues targeted research stage tasks until quality convergence

## 3. Cycle Lifecycle

- Restore existing `running` cycle on startup (or auto-start if none)
- End conditions:
  - Maximum elapsed time
  - Maximum completed task count
  - Maximum failure rate
- On cycle end, start next cycle after cleanup when needed

## 4. Anomaly Detection and Recovery

- Monitored:
  - High failure rate
  - Cost spike
  - Stuck task
  - No progress
  - Agent timeout
- For some critical anomalies like `stuck_task`, cycle restart is performed
- Anomalies have duplicate notification cooldown

## 5. Replan and Backlog Policy

- After task backlog is empty, first sync issue backlog via `/system/preflight`
- Replan is deferred while issue backlog exists
- Replan only when backlog is empty and conditions such as planner idle are met
- Requirement hash + repo head are signed to suppress no-diff replan per config

Research-specific backlog note:

- Research jobs with active stages are converged via research orchestration before normal replan progression.

## 6. CLI Commands

- `status`
- `anomalies`
- `clear-anomalies`
- `end-cycle`
- `new-cycle`
- `cleanup`

## 7. Implementation Reference (Source of Truth)

- Startup and common control: `apps/cycle-manager/src/main.ts`, `apps/cycle-manager/src/cycle-controller.ts`
- Main loop: `apps/cycle-manager/src/main/loops.ts`
- Backlog sync and replan: `apps/cycle-manager/src/main/backlog-preflight.ts`, `apps/cycle-manager/src/main/replan.ts`
- Anomaly detection: `apps/cycle-manager/src/monitors/anomaly-detector.ts`
- Recovery cleanup: `apps/cycle-manager/src/cleaners/cleanup.ts`, `apps/cycle-manager/src/cleaners/cleanup-retry.ts`
- Research orchestration: `apps/cycle-manager/src/main/research-orchestrator.ts`

## 8. Main Configuration

- `MONITOR_INTERVAL_MS`
- `CLEANUP_INTERVAL_MS`
- `STATS_INTERVAL_MS`
- `AUTO_START_CYCLE`
- `AUTO_REPLAN`
- `REPLAN_INTERVAL_MS`
- `REPLAN_REQUIREMENT_PATH`
- `REPLAN_COMMAND`
- `SYSTEM_API_BASE_URL`
- `ISSUE_SYNC_INTERVAL_MS`
- `ISSUE_SYNC_TIMEOUT_MS`
- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `STUCK_RUN_TIMEOUT_MS`
- `CYCLE_MAX_DURATION_MS`
- `CYCLE_MAX_TASKS`
- `CYCLE_MAX_FAILURE_RATE`
- `RESEARCH_ENABLED`
- `RESEARCH_PLANNER_PENDING_WINDOW_MS`
- `RESEARCH_MAX_CONCURRENCY`
- `RESEARCH_MAX_DEPTH`
- `RESEARCH_MIN_EVIDENCE_PER_CLAIM`
- `RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM`
- `RESEARCH_REQUIRE_COUNTER_EVIDENCE`
- `RESEARCH_MIN_REPORT_CONFIDENCE`
- `RESEARCH_MIN_VERIFIABLE_RATIO`
