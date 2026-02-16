# Dispatcher Agent Specification

Related:

- [README](README.md)
- [flow](../flow.md)
- [mode](../mode.md)

## 1. Role

Dispatcher safely advances `queued` tasks to `running` and assigns them to the right execution agent.  
It also monitors lease/heartbeat to prevent duplicate execution and dropped tasks.

Out of scope:

- Task content implementation (code changes)
- Run artifact approve/rework decisions

## 2. Input

- Current state of `tasks` / `runs` / `leases` / `agents`
- Task `priority`, `dependencies`, `targetArea`, `lane`, `role`
- Execution mode (`LAUNCH_MODE=process|docker`)
- Repository execution mode (`REPO_MODE=git|local`)

## 3. Dispatch Pipeline

1. First recover lease anomalies and orphaned running tasks
2. Compute available slots (busy agent count + limit)
3. Collect `queued` tasks, filter by dependencies/conflicts
4. Apply lane budget (`feature` / `conflict_recovery` / `docser` / `research`) using active running usage and this-cycle dispatch usage
5. Sort by priority score within each lane
6. Select idle agent matching role
7. Atomically acquire lease and update `queued -> running`
8. Launch worker (queue enqueue or docker start)

## 4. Selection Logic and Guardrails

- `awaiting_judge` backlog is observed; hard block can be configured
- PR-review-only tasks that end up `queued` are moved to `blocked(awaiting_judge)`
- Recent failure/cancel suppresses re-dispatch during cooldown
- Tasks with conflicting `targetArea` are not run concurrently
- Tasks with unresolved `dependencies` are not dispatched
- Feature lane is protected from starvation by minimum-slot policy
- Conflict/docser lanes are capped; dispatcher emits lane-throttle telemetry events when caps block dispatch

Research-specific:

- Research tasks are `kind=research` and usually `role=worker`
- `targetArea` is claim-scoped (`research:<jobId>:claim:<claimId>`) to avoid same-claim overlap
- Queue and lease guards are identical to code tasks

## 5. Recovery Behavior

- Release expired leases and return tasks to `queued`
- Recover dangling leases left on queued tasks
- Recover tasks in `running` with no active run
- Reclaim leases from agents with lost heartbeat
- When `quota_wait` backlog is detected, temporarily limit concurrency to 1

## 6. Launch Modes

- `process`:
  - Enqueue to agent-specific queue for resident worker
  - Dispatcher does not start a new process each time
- `docker`:
  - Start worker container per task
  - Uses Docker image/network and log mount

## 7. Implementation Reference (Source of Truth)

- Startup and control loop: `apps/dispatcher/src/main.ts`, `apps/dispatcher/src/scheduler/index.ts`
- Lease management: `apps/dispatcher/src/scheduler/lease.ts`
- Agent heartbeat recovery: `apps/dispatcher/src/scheduler/heartbeat.ts`
- Priority calculation: `apps/dispatcher/src/scheduler/priority.ts`
- Worker launch branching: `apps/dispatcher/src/scheduler/worker-launcher.ts`

## 8. Main Configuration

- `POLL_INTERVAL_MS`
- `MAX_CONCURRENT_WORKERS`
- `LAUNCH_MODE`
- `DISPATCH_MAX_POLL_INTERVAL_MS`
- `DISPATCH_NO_IDLE_LOG_INTERVAL_MS`
- `DISPATCH_BLOCK_ON_AWAITING_JUDGE`
- `DISPATCH_RETRY_DELAY_MS`
- `DISPATCH_CONFLICT_LANE_MAX_SLOTS`
- `DISPATCH_FEATURE_LANE_MIN_SLOTS`
- `DISPATCH_DOCSER_LANE_MAX_SLOTS`
- `DISPATCH_AGENT_HEARTBEAT_TIMEOUT_SECONDS`
- `DISPATCH_AGENT_RUNNING_RUN_GRACE_MS`
- `SANDBOX_DOCKER_IMAGE`
- `SANDBOX_DOCKER_NETWORK`
