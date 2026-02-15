# State Model Reference

This page is a reference for openTiger's main status and transition vocabulary.  
For state transition flows, see [flow](flow.md).

Related:

- [flow](flow.md)
- [operations](operations.md)
- [agent/README](agent/README.md)

## Table of Contents

- [1. Task Status](#1-task-status)
- [1.1 Task Kind](#11-task-kind)
- [2. Task Block Reason](#2-task-block-reason)
- [2.1 Task Retry Reason (`GET /tasks`)](#21-task-retry-reason-get-tasks)
- [2.2 Task Retry Reason (Operations)](#22-task-retry-reason-operations)
- [3. Run Status](#3-run-status)
- [4. Agent Status](#4-agent-status)
- [5. Cycle Status](#5-cycle-status)
- [5.1 Research Job Status and Stage](#51-research-job-status-and-stage)
- [6. Usage](#6-usage)
- [7. Patterns Prone to Stalls (Initial Diagnosis)](#7-patterns-prone-to-stalls-initial-diagnosis)
- [8. Lookup: State Vocabulary -> Transition -> Owner -> Implementation (Shortest Path)](#8-lookup-state-vocabulary--transition--owner--implementation-shortest-path)

## 1. Task Status

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

Notes:

- `queued`: waiting for Dispatcher dispatch
- `running`: in execution via lease/run
- `blocked`: waiting for recovery per block reason

## 1.1 Task Kind

- `code`
- `research`

Notes:

- `code` follows git/local implementation pipeline
- `research` follows non-git evidence synthesis pipeline

## 2. Task Block Reason

- `awaiting_judge`
  - Waiting for judge of successful run, or judge recovery
- `quota_wait`
  - Cooldown wait after quota-related failure
- `needs_rework`
  - Non-approve / policy / verification rework
- `issue_linking`
  - Planner issue linkage; returns to `queued` when resolved

Notes:

- Legacy `needs_human` is treated as `awaiting_judge`.

## 2.1 Task Retry Reason (`GET /tasks`)

`failed` / `blocked` tasks include `retry` info; `reason` can be:

- `cooldown_pending`
- `retry_due`
- `retry_exhausted`
- `non_retryable_failure`
- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `unknown`

When `failureCategory` is present:

- `env`
- `setup`
- `policy`
- `test`
- `flaky`
- `model`
- `model_loop`

## 2.2 Task Retry Reason (Operations)

For initial triage, these values are most useful:

| `retry.reason`     | Meaning                         | Main check targets                                          |
| ------------------ | ------------------------------- | ----------------------------------------------------------- |
| `awaiting_judge`   | Stuck waiting for judge         | `GET /judgements`, `GET /system/processes`, `GET /logs/all` |
| `quota_wait`       | Waiting for quota cooldown      | `GET /tasks`, `GET /runs`, `GET /logs/all`                  |
| `needs_rework`     | Moving into rework loop         | `GET /runs`, `GET /judgements`, `GET /logs/all`             |
| `cooldown_pending` | In cooldown (before auto retry) | `retryAt`/`retryInSeconds` in `GET /tasks`                  |
| `retry_due`        | Retry time reached              | `GET /tasks`, `GET /logs/all`                               |

## 3. Run Status

- `running`
- `success`
- `failed`
- `cancelled`

## 4. Agent Status

- `idle`
- `busy`
- `offline`

Notes:

- These apply to roles in the `agents` table (`planner`/`worker`/`tester`/`docser`/`judge`).
- Dispatcher / Cycle Manager are process-managed; use `GET /system/processes`.

## 5. Cycle Status

- `running`
- `completed`
- `aborted`

## 5.1 Research Job Status and Stage

Research job status (`research_jobs.status`):

- `queued`
- `running`
- `blocked`
- `done`
- `failed`
- `cancelled`

Research task stage (`tasks.context.research.stage`):

- `plan`
- `collect`
- `challenge`
- `write`

Research orchestrator stage (`research_jobs.metadata.orchestrator.stage`) commonly observed:

- `planning`
- `collecting`
- `challenging`
- `composing`
- `judging`
- `reworking`
- `completed`

## 6. Usage

- State definitions: this page
- Transition conditions: [flow](flow.md)
- Startup formulas: [startup-patterns](startup-patterns.md)

## 6.1 Implementation Reference (Source of Truth)

- Task status / block reason:
  - `packages/core/src/domain/task.ts`
  - `packages/db/src/schema.ts` (`tasks.status`, `tasks.block_reason`)
- Run status:
  - `packages/core/src/domain/run.ts`
  - `packages/db/src/schema.ts` (`runs.status`)
- Agent status:
  - `packages/core/src/domain/agent.ts`
  - `packages/db/src/schema.ts` (`agents.status`)
- Cycle status:
  - `packages/core/src/domain/cycle.ts`
  - `packages/db/src/schema.ts` (`cycles.status`)

## 7. Patterns Prone to Stalls (Initial Diagnosis)

| Symptom                          | First check state/value                                   | Main APIs                                                   | Primary area to check          |
| -------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| `queued` not decreasing for long | `agents` idle/busy, lease, dependency/targetArea conflict | `GET /agents`, `GET /tasks`, `GET /logs/all`                | Dispatcher                     |
| `running` stuck for long         | Corresponding run `status`, startedAt, worker logs        | `GET /runs`, `GET /tasks`, `GET /logs/all`                  | Worker/Tester/Docser           |
| `awaiting_judge` increasing      | Pending judge run, judge process status                   | `GET /judgements`, `GET /system/processes`, `GET /logs/all` | Judge                          |
| `quota_wait` chaining            | Cooldown wait, concurrency, model quota                   | `GET /tasks`, `GET /runs`, `GET /logs/all`                  | Worker + Dispatcher            |
| `needs_rework` chaining          | Non-approve reason, policy/verification failure content   | `GET /judgements`, `GET /runs`, `GET /logs/all`             | Judge + Worker + Cycle Manager |
| `issue_linking` not clearing     | Issue linkage metadata missing, import/link failure       | `GET /tasks`, `POST /system/preflight`, `GET /logs/all`     | Planner + API                  |

Notes:

- For API check sequence, see [operations](operations.md#11-post-change-verification-checklist).
- For agent triage confusion, see FAQ in [agent/README](agent/README.md).

## 8. Lookup: State Vocabulary -> Transition -> Owner -> Implementation (Shortest Path)

Common path when tracing from state vocabulary:

| Starting point (state/symptom)    | State vocabulary ref | Transition ref (flow)                                                                                   | Owner agent ref                                                              | Implementation ref                                               |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `queued`/`running` stuck          | 1, 2, 7              | [flow#2 Basic Lifecycle](flow.md#2-basic-lifecycle), [flow#5 Dispatcher Recovery](flow.md#5-dispatcher-recovery-layer), [flow#6 Worker Failure](flow.md#6-worker-failure-handling) | [agent/dispatcher](agent/dispatcher.md), [agent/worker](agent/worker.md)     | `apps/dispatcher/src/`, `apps/worker/src/`                       |
| `awaiting_judge` stuck            | 2, 7                 | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [flow#4 Run Lifecycle](flow.md#4-run-lifecycle-and-judge-idempotency), [flow#7 Judge](flow.md#7-judge-non-approval--merge-failure-paths) | [agent/judge](agent/judge.md)                                                 | `apps/judge/src/`                                                |
| `quota_wait`/`needs_rework` chain | 2, 2.2, 7            | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [flow#6 Worker Failure](flow.md#6-worker-failure-handling), [flow#8 Cycle Manager](flow.md#8-cycle-manager-self-recovery) | [agent/worker](agent/worker.md), [agent/judge](agent/judge.md), [agent/cycle-manager](agent/cycle-manager.md) | `apps/worker/src/`, `apps/judge/src/`, `apps/cycle-manager/src/` |
| `issue_linking` stuck             | 2, 7                 | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [startup-patterns](startup-patterns.md)                                     | [agent/planner](agent/planner.md)                                             | `apps/planner/src/`                                              |

Notes:

- After checking responsibilities in flow, use "Implementation reference (source of truth)" at the end of agent spec pages to trace at file level.
