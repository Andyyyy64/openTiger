# Operations Guide

This document summarizes operational procedures for continuous openTiger operation.

Related:

- `docs/flow.md`
- `docs/state-model.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/agent/dispatcher.md`
- `docs/agent/cycle-manager.md`

## 1. State to Monitor

### Main Task States

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

### Main Block Reasons

- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `issue_linking`

Seeing both `failed` and `retry countdown` is normal: run shows failure, task shows next retry wait.

### Initial Triage for `retry.reason`

`retry.reason` in `GET /tasks` helps triage quickly:

| reason                           | First check                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| `awaiting_judge`                 | `GET /judgements`, `GET /system/processes`, `GET /logs/all` |
| `quota_wait`                     | `GET /tasks`, `GET /runs`, `GET /logs/all`                  |
| `needs_rework`                   | `GET /runs`, `GET /judgements`, `GET /logs/all`             |
| `cooldown_pending` / `retry_due` | `retryAt` / `retryInSeconds` in `GET /tasks`                |

## 2. Process Operations

### Start/Stop

- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

`stop-all` behavior:

- Stop managed processes
- Attempt to force-terminate orphan system processes
- Update `runs.status=running` to `cancelled`
- Return corresponding `tasks.status=running` to `queued`
- Release corresponding leases
- Update execution agents to `offline`
- Disarm runtime hatch

### Process Names

Fixed:

- `planner`
- `dispatcher`
- `cycle-manager`
- `db-up`
- `db-down`
- `db-push`

Dynamic:

- `judge`, `judge-2...`
- `worker-1...`
- `tester-1...`
- `docser-1...`

Research-specific:

- `planner` may be started with `researchJobId` payload for planner-first decomposition

## 3. Runtime Hatch and Self-Recovery

openTiger controls process self-recovery via runtime hatch (event-based).

Main events:

- `system.runtime_hatch_armed`
- `system.runtime_hatch_disarmed`

Used for:

- Deciding whether execution processes are "continue-running target"
- Gating all self-heal auto-start behavior while armed

CLI commands:

```bash
pnpm runtime:hatch:status
pnpm runtime:hatch:arm
pnpm runtime:hatch:disarm
```

## 4. Related Env Vars for Auto-Restart and Self-Recovery

### Process Auto-Restart

- `SYSTEM_PROCESS_AUTO_RESTART`
- `SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS`

### Self-Heal Loop

- `SYSTEM_PROCESS_SELF_HEAL`
- `SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS`
- `SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS`
- `SYSTEM_AGENT_LIVENESS_WINDOW_MS`

### Task Retry

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD`
- `DISPATCH_RETRY_DELAY_MS`

Behavior note:

- Failure classification is structured-first from `runs.error_meta.failureCode`.
- For old runs without `error_meta`, message fallback classification remains active.

### Policy / Rework Suppression

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`
- `AUTO_REWORK_MAX_DEPTH`

## 5. Cleanup Warnings

`POST /system/cleanup` performs:

- Full queue initialization (obliterate)
- Initialize runtime tables (tasks/runs/artifacts/leases/events/cycles)
- Update agent state to `idle`

Destructive; use sparingly in normal operation.

Usage:

- `stop-all`: stop running processes + safe rollback of running tasks
- `cleanup`: initialize data/queue (wipes history)

## 6. Log Operations

### Read

- `GET /logs/agents/:id`
- `GET /logs/cycle-manager`
- `GET /logs/all`

### Clear

- `POST /logs/clear`
  - Truncates open files, deletes unused files

## 7. Initial Incident Triage

1. Check `blockReason` in `tasks`
2. Check error body and artifacts in `runs/:id`
3. Check non-approve / merge failure in `judgements`
4. Check dispatcher / cycle-manager / judge / worker correlation in `logs/all`
5. If needed, `stop-all` -> restart

TigerResearch-specific first triage:

1. `GET /plugins/tiger-research/jobs`
2. `GET /plugins/tiger-research/jobs/:id`
3. `GET /tasks` (filter `kind=research`)
4. `GET /runs` + `GET /logs/all`

## 8. Symptom-Based Check Targets

For fastest initial diagnosis, first check "Patterns prone to stalls (initial diagnosis)" in `docs/state-model.md`.

- Task not progressing from `queued`
  - Check dispatcher status, lease anomalies, role-wise idle agent count
  - Ref: `docs/agent/dispatcher.md`
- `awaiting_judge` not clearing for long
  - Check judge process and pending judge runs
  - Ref: `docs/agent/judge.md`
- Not recovering after failure
  - Check cycle-manager cleanup/requeue logs
  - Ref: `docs/agent/cycle-manager.md`
- Verification command failures repeating
  - Check run failure content and presence of verification recovery
  - Ref: `docs/verification.md`
- Task stuck at `issue_linking`
  - Check issue linkage resolution failure or import non-convergence; rerun preflight if needed
  - Ref: `docs/startup-patterns.md`
- Planner not restarting
  - Check backlog gate (issue/pr/local task) and replan conditions
  - Ref: `docs/startup-patterns.md`
- Research runs repeatedly cancelled
  - Check API restart events (`SIGTERM`) and managed process churn
  - Confirm `OPENTIGER_PRESERVE_MANAGED_ON_DEV_SIGTERM` behavior in `dev`
  - Ref: `docs/research.md`

Note:

- For agent triage confusion, see FAQ in `docs/agent/README.md`.

### 8.1 State Vocabulary -> Transition -> Owner -> Implementation Lookup (Operation Shortcut)

Common path when tracing from state vocabulary to transition to owner to implementation during incidents.

| Starting point (state/symptom)    | State vocabulary ref         | Transition ref (flow)  | Owner agent ref                               | Implementation ref                                   |
| --------------------------------- | ---------------------------- | ---------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `queued` stuck                    | `docs/state-model.md` 7      | `docs/flow.md` 2, 5    | Dispatcher (`docs/agent/dispatcher.md`)       | `apps/dispatcher/src/`                               |
| `running` stuck                   | `docs/state-model.md` 7      | `docs/flow.md` 2, 6    | Worker/Tester/Docser (`docs/agent/worker.md`) | `apps/worker/src/`                                   |
| `awaiting_judge` stuck            | `docs/state-model.md` 2, 7   | `docs/flow.md` 3, 4, 7 | Judge (`docs/agent/judge.md`)                 | `apps/judge/src/`                                    |
| `quota_wait`/`needs_rework` chain | `docs/state-model.md` 2, 2.2 | `docs/flow.md` 3, 6, 8 | Worker/Judge/Cycle Manager (each agent spec)  | "Implementation reference" at end of each agent spec |
| `issue_linking` stuck             | `docs/state-model.md` 2, 7   | `docs/flow.md` 3       | Planner (`docs/agent/planner.md`)             | `apps/planner/src/`                                  |

Note:

- "Implementation reference (source of truth)" at the end of agent spec pages links directly to `main.ts` and main loop implementations.

## 9. Extra Checks for Sandbox Operation

- With `EXECUTION_ENVIRONMENT=sandbox`, worker/tester/docser run in Docker
- Verify `SANDBOX_DOCKER_IMAGE` and `SANDBOX_DOCKER_NETWORK`
- For Claude executor, verify host auth dir mount

## 10. Safe Restart Procedure for Config Changes

Prerequisites:

- First check "Config change impact map" in `docs/config.md` for affected components
- If scope is narrow, restart only affected processes rather than `stop-all`

### 10.1 Basic Partial Restart Order

1. `stop` affected processes
2. `start` in dependency order (control -> execution)
3. Confirm recovery in `tasks`/`runs`/`logs`

Recommended order (general):

- Restart `cycle-manager` / `dispatcher` / `judge` first
- Then restart `worker`/`tester`/`docser`

### 10.2 Representative Patterns

- When changing `DISPATCH_*` / `MAX_CONCURRENT_WORKERS`
  - Restart `dispatcher`
- When changing `WORKER_*` / `TESTER_*` / `DOCSER_*` / `WORKER_LLM_EXECUTOR` / `TESTER_LLM_EXECUTOR` / `DOCSER_LLM_EXECUTOR`
  - Restart target role agents (worker/tester/docser)
- When changing `JUDGE_*` / `JUDGE_LLM_EXECUTOR` / `JUDGE_MODE` / `LLM_EXECUTOR` (when judge uses `inherit`)
  - Restart `judge`
- When changing `PLANNER_LLM_EXECUTOR` / `LLM_EXECUTOR` (when planner uses `inherit`)
  - Restart `planner`
- When changing `LLM_EXECUTOR` (worker/tester/docser use `inherit`)
  - Restart target role agents (worker/tester/docser)
- When changing `AUTO_REPLAN` / `REPLAN_*` / `FAILED_TASK_*`
  - Restart `cycle-manager`
- When changing `EXECUTION_ENVIRONMENT` / `SANDBOX_DOCKER_*`
  - Restart `dispatcher` and execution agents

### 10.3 When to Use `stop-all`

- Large config change where affected scope cannot be identified
- Process state inconsistent; partial restart doesn't converge
- Want to safely roll back running tasks and reset

## 11. Post-Change Verification Checklist

After config changes or restarts, check in order to detect missing updates:

### 11.0 API Quick Reference

| Check           | API                     |
| --------------- | ----------------------- |
| Process state   | `GET /system/processes` |
| Agent state     | `GET /agents`           |
| Task backlog    | `GET /tasks`            |
| Run anomalies   | `GET /runs`             |
| Correlated logs | `GET /logs/all`         |

### 11.1 Process State

- `GET /system/processes`
  - Target processes returned to `running`
  - No unintended processes left `stopped`

### 11.2 Agent State

- `GET /agents`
  - Restarted role agents re-registered
  - No agents staying `offline`
  - Targets: `planner`/`worker`/`tester`/`docser`/`judge` (Dispatcher/Cycle Manager via `GET /system/processes`)

### 11.3 Task / Run Convergence

- `GET /tasks`
  - `running` not stuck for long
  - `blocked` not unexpectedly increasing
- `GET /runs`
  - Runs right after restart not consecutively `failed`

### 11.4 Log Check

- `GET /logs/all`
  - No config read errors in target processes
  - Dispatcher/Worker/Judge/Cycle Manager heartbeats continuing

### 11.5 Assessment Criteria

- Normal:
  - Queue flows; `queued -> running -> done`/`blocked` transitions resume
  - `awaiting_judge` backlog not growing
- Needs further investigation:
  - Same error causing consecutive `failed`
  - Only certain roles not recovering agents
  - `quota_wait`/`needs_rework` surging
  - Research jobs stuck in `planning` with no claims/tasks growth

### 11.6 Minimal Check Commands (curl)

Use `X-API-Key` or `Authorization: Bearer` when auth is required.

```bash
# Example: with API key
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/health/ready
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/system/processes
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/agents
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/tasks
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/runs
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/logs/all
```
