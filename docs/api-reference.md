# API Reference

The openTiger API is Hono-based; the dashboard uses the same endpoints.  
Base URL is typically `http://localhost:4301`.

Related:

- [config](config.md)
- [operations](operations.md)
- [state-model](state-model.md)
- [agent/dispatcher](agent/dispatcher.md)
- [agent/cycle-manager](agent/cycle-manager.md)

## 1. Authentication and Rate Limiting

### Authentication Methods

- `X-API-Key` (`API_KEYS`)
- `Authorization: Bearer <token>` (`API_SECRET` or custom validator)

Auth skipped:

- `/health*`
- `/webhook/github`
- `/api/webhook/github` (compatibility path when API prefix is used)

System control APIs require `canControlSystem()` for access.

- `api-key` / `bearer`: always allowed
- Local operation: allowed unless `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL=false`

Main targets:

- `/system/*`
- `POST /logs/clear`

### Rate Limiting

- Default: 100 requests per minute
- Redis counter when available; in-memory fallback on failure

---

## 2. API Map by Operation Purpose

| Purpose              | Main APIs                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Health check         | `GET /health`, `GET /health/ready`                                                                              |
| State monitoring     | `GET /tasks`, `GET /runs`, `GET /judgements`, `GET /agents`, `GET /logs/all`                                    |
| Config changes       | `GET /config`, `PATCH /config`                                                                                  |
| Startup control      | `POST /system/processes/:name/start`, `POST /system/processes/:name/stop`, `POST /system/processes/stop-all`    |
| Pre-start validation | `POST /system/preflight`                                                                                        |
| Recovery/maintenance | `POST /system/cleanup`, `POST /logs/clear`                                                                      |
| GitHub integration   | `GET /system/github/auth`, `GET /system/github/repos`, `POST /system/github/repo`, `POST /webhook/github`       |
| Requirement updates  | `GET /system/requirements`, `POST /system/requirements`                                                         |
| TigerResearch plugin | `GET /plugins/tiger-research/jobs`, `GET /plugins/tiger-research/jobs/:id`, `POST /plugins/tiger-research/jobs` |
| Plugin inventory     | `GET /plugins`                                                                                                  |

Note:

- For task/run state vocabulary (`queued`, `blocked`, `awaiting_judge`, etc.), see [state-model](state-model.md).

## 2.1 Minimal API Set for Operations

Minimum set for incident triage and daily operations.

| Use             | API                     | What to check                                        |
| --------------- | ----------------------- | ---------------------------------------------------- |
| Overall health  | `GET /health/ready`     | DB/Redis connectivity                                |
| Process state   | `GET /system/processes` | running/stopped distribution, missing processes      |
| Agent activity  | `GET /agents`           | offline distribution, counts per role                |
| Task backlog    | `GET /tasks`            | stuck `queued`, surge in `blocked`                   |
| Run anomalies   | `GET /runs`             | consecutive `failed` with same error, long `running` |
| Judge stall     | `GET /judgements`       | non-approve chain, unprocessed backlog               |
| Correlated logs | `GET /logs/all`         | dispatcher/worker/judge/cycle-manager timeline       |

For operation check sequence, refer to [operations](operations.md#11-post-change-verification-checklist).

## 2.2 API-Based Lookup (State Vocabulary -> Transition -> Owner -> Implementation)

Common path when tracing from state vocabulary to transition to owner to implementation after finding anomalies via API.

| Starting point (API/symptom)                      | State vocabulary ref                                                                                                                      | Transition ref (flow)                                                                                                                                                 | Owner agent ref                                                     | Implementation ref                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `queued`/`running` stuck in `GET /tasks`          | [state-model](state-model.md#7-patterns-prone-to-stalls-initial-diagnosis)                                                                | [flow](flow.md#2-basic-lifecycle), [flow](flow.md#5-dispatcher-recovery-layer), [flow](flow.md#6-worker-failure-handling)                                             | [Dispatcher/Worker](agent/dispatcher.md), [Worker](agent/worker.md) | `apps/dispatcher/src/`, `apps/worker/src/`    |
| `awaiting_judge` stuck in `GET /tasks`            | [state-model](state-model.md#2-task-block-reason), [state-model](state-model.md#7-patterns-prone-to-stalls-initial-diagnosis)             | [flow](flow.md#3-blocked-reasons-used-for-recovery), [flow](flow.md#4-run-lifecycle-and-judge-idempotency), [flow](flow.md#7-judge-non-approval--merge-failure-paths) | [Judge](agent/judge.md)                                             | `apps/judge/src/`                             |
| `quota_wait`/`needs_rework` chain in `GET /tasks` | [state-model](state-model.md#22-task-retry-reason-operations), [state-model](state-model.md#7-patterns-prone-to-stalls-initial-diagnosis) | [flow](flow.md#3-blocked-reasons-used-for-recovery), [flow](flow.md#6-worker-failure-handling), [flow](flow.md#8-cycle-manager-self-recovery)                         | Worker/Judge/Cycle Manager (each agent spec)                        | "Implementation reference" in each agent spec |
| `issue_linking` stuck in `GET /tasks`             | [state-model](state-model.md#2-task-block-reason), [state-model](state-model.md#7-patterns-prone-to-stalls-initial-diagnosis)             | [flow](flow.md#3-blocked-reasons-used-for-recovery)                                                                                                                   | [Planner](agent/planner.md)                                         | `apps/planner/src/`                           |

Note:

- Operation shortcut table: [operations](operations.md#81-state-vocabulary--transition--owner--implementation-lookup-operation-shortcut)
- Owner agent and implementation entry: [agent/README](agent/README.md#10-shortest-route-for-implementation-tracing-code-reading-order)

---

## 3. Main Endpoints

### Health

- `GET /health`
- `GET /health/ready`
  - Returns DB and Redis connectivity check

### Config

- `GET /config`
  - Returns current `system_config` values
- `PATCH /config`
  - `{ updates: Record<string, string> }`
  - Unknown keys are rejected

### Tasks

- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`

Note:

- failed/blocked tasks include `retry` info (cooldown / reason / retryCount, etc.)
- Main `retry.reason` values:
  - `cooldown_pending`, `retry_due`, `awaiting_judge`, `quota_wait`, `needs_rework`
- Full vocabulary (`retry_exhausted`, `non_retryable_failure`, `unknown`, `failureCategory`) in [state-model](state-model.md)

`retry` example:

```json
{
  "autoRetry": true,
  "reason": "quota_wait",
  "retryAt": "2026-02-13T11:20:00.000Z",
  "retryInSeconds": 42,
  "cooldownMs": 120000,
  "retryCount": 3,
  "retryLimit": -1
}
```

### Runs

- `GET /runs`
- `GET /runs/:id`
- `GET /runs/stats`
- `GET /runs/:id/artifacts/:artifactId/content`
- `POST /runs`
- `PATCH /runs/:id`
- `POST /runs/:id/cancel`
- `POST /runs/:id/artifacts`

Notes:

- `GET /runs/:id/artifacts/:artifactId/content` serves file-backed artifact content (for example visual probe screenshots).

### Agents

- `GET /agents`
- `GET /agents/:id`
- `POST /agents`
- `POST /agents/:id/heartbeat`
- `DELETE /agents/:id`

Note:

- `GET /agents` returns `planner/worker/tester/docser/judge` status.
- Dispatcher / Cycle Manager are managed as processes; use `GET /system/processes`.

### Plans

- `GET /plans`
  - Returns plan snapshots from `planner.plan_created` events

### Judgements

- `GET /judgements`
- `GET /judgements/:id/diff`

### Logs

- `GET /logs/agents/:id`
- `GET /logs/cycle-manager`
- `GET /logs/all`
- `POST /logs/clear`

### TigerResearch (Plugin)

- `GET /plugins/tiger-research/jobs`
  - Query params: `status`, `limit`
- `GET /plugins/tiger-research/jobs/:id`
  - Returns job + claims + evidence + reports + linked tasks/runs
- `POST /plugins/tiger-research/jobs`
  - Creates research job
  - Ensures runtime and planner startup
  - On planner startup failure, fallback `plan` task is created
- `POST /plugins/tiger-research/jobs/:id/tasks`
  - Manual stage task injection (`plan`/`collect`/`challenge`/`write`)
- `DELETE /plugins/tiger-research/jobs`
  - Deletes all research jobs and linked runtime rows

`/research/*` aliases are removed. Use only `/plugins/tiger-research/*`.

### Plugin Inventory

- `GET /plugins`
  - Returns plugin load status and capabilities.
  - Status values:
    - `enabled`
    - `disabled`
    - `incompatible`
    - `error`
  - Main fields:
    - `id`
    - `version`
    - `pluginApiVersion`
    - `status`
    - `capabilities`
    - `reason` (optional)

### Webhook / GitHub

- `POST /webhook/github`
  - Signature verification when `GITHUB_WEBHOOK_SECRET` is set

Current implementation behavior:

- Received events stored in `events` table
- Handles `issues` / `pull_request` / `push` / `check_run` / `check_suite`
- When PR is closed+merged with `[task:<uuid>]` in body, updates task to `done`
- Otherwise mainly for recording/notification; planner/dispatcher drive via `/system/preflight` etc.

---

## 4. System APIs

### Auth Status

- `GET /system/github/auth`
- `GET /system/claude/auth?environment=host|sandbox`
- `GET /system/codex/auth?environment=host|sandbox`

### Requirement Operations

- `GET /system/requirements`
- `POST /system/requirements`
  - Syncs to canonical path `docs/requirement.md`
  - For git repositories, attempts snapshot commit/push

### Preflight

- `POST /system/preflight`
  - Returns recommended startup configuration from requirement content + local backlog + GitHub issue/PR backlog

### Runtime Throughput / Conflict Telemetry

- `GET /system/runtime/throughput`
  - Returns:
    - merge queue status counts (`pending`/`processing`/`merged`/`failed`/`cancelled`)
    - lane backlog/running counts by `tasks.lane`
    - recent event counts (6h window):
      - `judge.merge_queue_*`
      - `dispatcher.lane_throttled`
      - `worker.push_divergence_guard_triggered`

### Process Manager (system)

- `GET /system/processes`
- `GET /system/processes/:name`
- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

Planner research start payload:

- `POST /system/processes/planner/start` body can include `{ "researchJobId": "<uuid>" }`
- In this mode, planner runs `--research-job` path and skips requirement preflight gating

### Repository Operations (GitHub)

- `POST /system/github/repo`
  - Create repository + config sync
- `GET /system/github/repos`
  - List repos accessible to authenticated user

### Host Info

- `GET /system/host/neofetch`
- `GET /system/host/context`

### Maintenance

- `POST /system/cleanup`
  - Initializes runtime tables and queue

---

## 5. Important Preflight Behavior

- Planner is recommended only when all of the following hold:
  - Requirement is non-empty
  - No issue backlog
  - No judge backlog
  - No local task backlog
- Issue -> task auto-generation requires explicit role:
  - label: `role:worker|role:tester|role:docser`
  - or body with `Agent:` / `Role:` or `## Agent` section

## 6. Sample Responses

### `POST /system/preflight` (excerpt)

```json
{
  "preflight": {
    "github": {
      "enabled": true,
      "openIssueCount": 3,
      "openPrCount": 1,
      "issueTaskBacklogCount": 2,
      "generatedTaskCount": 1,
      "warnings": []
    },
    "local": {
      "queuedTaskCount": 4,
      "runningTaskCount": 1,
      "failedTaskCount": 0,
      "blockedTaskCount": 2,
      "pendingJudgeTaskCount": 1
    }
  },
  "recommendations": {
    "startPlanner": false,
    "startDispatcher": true,
    "startJudge": true,
    "startCycleManager": true,
    "workerCount": 4,
    "testerCount": 4,
    "docserCount": 4,
    "plannerCount": 0,
    "judgeCount": 4,
    "reasons": ["Issue backlog detected (2)"]
  }
}
```

### `GET /system/processes` (excerpt)

```json
{
  "processes": [
    {
      "name": "dispatcher",
      "kind": "service",
      "status": "running",
      "supportsStop": true,
      "startedAt": "2026-02-13T10:00:00.000Z",
      "pid": 12345
    },
    {
      "name": "worker-1",
      "kind": "worker",
      "status": "running",
      "supportsStop": true
    }
  ]
}
```

---

## 7. Integration Notes

- No direct command execution API from outside; control via process manager
- `stop-all` cancels/requeues running runs and updates agent state
- In sandbox execution, worker/tester/docser host processes are not normally started
- `/system/*` and `POST /logs/clear` require `canControlSystem()` permission

Supplemental material for operational issues:

- dispatch/lease: [agent/dispatcher](agent/dispatcher.md)
- convergence/replan: [agent/cycle-manager](agent/cycle-manager.md)
