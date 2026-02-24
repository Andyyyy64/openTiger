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
- [1.2 Task Lane](#12-task-lane)
- [2. Task Block Reason](#2-task-block-reason)
- [2.1 Task Retry Reason (`GET /tasks`)](#21-task-retry-reason-get-tasks)
- [2.2 Task Retry Reason (Operations)](#22-task-retry-reason-operations)
- [3. Run Status](#3-run-status)
- [3.1 Merge Queue Status](#31-merge-queue-status)
- [4. Agent Status](#4-agent-status)
- [5. Cycle Status](#5-cycle-status)
- [5.1 Research Job Status and Stage](#51-research-job-status-and-stage)
- [6. Conversation Phase (Chat)](#6-conversation-phase-chat)
- [7. Usage](#7-usage)
- [8. Patterns Prone to Stalls (Initial Diagnosis)](#8-patterns-prone-to-stalls-initial-diagnosis)
- [9. Lookup: State Vocabulary to Transition to Owner to Implementation (Shortest Path)](#9-lookup-state-vocabulary-to-transition-to-owner-to-implementation-shortest-path)

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

- `code` (core built-in)
- plugin-defined kinds (registered through `PluginManifestV1.taskKinds`)

Notes:

- `code` follows github/local-git/direct implementation pipeline depending on `REPO_MODE`.
- Plugin kinds are validated against runtime plugin registry before task creation/dispatch.
- Unknown/unregistered kinds are rejected at API validation time.

## 1.2 Task Lane

- `feature` (core built-in)
- `conflict_recovery` (core built-in)
- `docser` (core built-in)
- plugin-defined lanes (registered through `PluginManifestV1.lanes`)

Notes:

- Dispatcher lane scheduler uses lane + active running usage to prevent feature starvation.
- `docser` lane is serialized through `targetArea=docser:global`.
- `conflict_recovery` lane is capped to avoid monopolizing worker slots.
- Plugin lanes are admitted only when declared by an enabled compatible plugin.

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

## 3.1 Merge Queue Status

`pr_merge_queue.status`:

- `pending`
- `processing`
- `merged`
- `failed`
- `cancelled`

Notes:

- `pending` rows are claimable when `next_attempt_at <= now`.
- `processing` rows require valid claim lease (`claim_owner`, `claim_expires_at`).
- On claim timeout, recovery transitions `processing -> pending`.

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

## 6. Conversation Phase (Chat)

Conversations in the chat interface progress through phases stored in `conversations.metadata.phase`:

- `greeting` — initial state, assistant greeting shown
- `requirement_gathering` — user providing requirements, LLM asking minimal clarifications
- `plan_proposal` — LLM has generated a plan (triggered by `---PLAN_READY---` marker)
- `execution` — mode selected, execution processes started
- `monitoring` — execution in progress, tracking completion

Notes:

- Phase transition from `requirement_gathering` → `plan_proposal` is marker-based, not message-count-based
- `plan_proposal` triggers a `mode_selection` system message for the UI
- `execution` is set by `POST /chat/conversations/:id/start-execution`

### 6.1 Chat Message Types

- `text` — standard conversation messages (user/assistant), included in LLM context
- `mode_selection` — system card for execution mode selection (direct/local-git/github)
- `execution_status` — system card showing execution start and mode
- `repo_config` — system message for repository configuration changes

Implementation reference:

- `packages/db/src/schema.ts` (`conversations`, `messages` tables)
- `apps/api/src/routes/chat-orchestrator.ts` (phase resolution, system prompts)
- `apps/api/src/routes/chat.ts` (endpoints, marker detection)
- `apps/api/src/routes/chat-state.ts` (SSE session management)

## 7. Usage

- State definitions: this page
- Transition conditions: [flow](flow.md)
- Startup formulas: [startup-patterns](startup-patterns.md)

## 7.1 Implementation Reference (Source of Truth)

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

## 8. Patterns Prone to Stalls (Initial Diagnosis)

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

## 9. Lookup: State Vocabulary to Transition to Owner to Implementation (Shortest Path)

Common path when tracing from state vocabulary:

| Starting point (state/symptom)    | State vocabulary ref | Transition ref (flow)                                                                                                                                                                                           | Owner agent ref                                                                                               | Implementation ref                                               |
| --------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `queued`/`running` stuck          | 1, 2, 7              | [flow#2 Basic Lifecycle](flow.md#2-basic-lifecycle), [flow#5 Dispatcher Recovery](flow.md#5-dispatcher-recovery-layer), [flow#6 Worker Failure](flow.md#6-worker-failure-handling)                              | [agent/dispatcher](agent/dispatcher.md), [agent/worker](agent/worker.md)                                      | `apps/dispatcher/src/`, `apps/worker/src/`                       |
| `awaiting_judge` stuck            | 2, 7                 | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [flow#4 Run Lifecycle](flow.md#4-run-lifecycle-and-judge-idempotency), [flow#7 Judge](flow.md#7-judge-non-approval--merge-failure-paths) | [agent/judge](agent/judge.md)                                                                                 | `apps/judge/src/`                                                |
| `quota_wait`/`needs_rework` chain | 2, 2.2, 7            | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [flow#6 Worker Failure](flow.md#6-worker-failure-handling), [flow#8 Cycle Manager](flow.md#8-cycle-manager-self-recovery)                | [agent/worker](agent/worker.md), [agent/judge](agent/judge.md), [agent/cycle-manager](agent/cycle-manager.md) | `apps/worker/src/`, `apps/judge/src/`, `apps/cycle-manager/src/` |
| `issue_linking` stuck             | 2, 7                 | [flow#3 Blocked Reasons](flow.md#3-blocked-reasons-used-for-recovery), [startup-patterns](startup-patterns.md)                                                                                                  | [agent/planner](agent/planner.md)                                                                             | `apps/planner/src/`                                              |

Notes:

- After checking responsibilities in flow, use "Implementation reference (source of truth)" at the end of agent spec pages to trace at file level.
