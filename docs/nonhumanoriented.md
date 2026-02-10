# Non-Human-Oriented Operation Principles

## 1. Objective

Maintain autonomous progress without manual babysitting.

Practical definition:

- no silent deadlock
- no infinite same-step loop without state change
- repeated failures are converted into a different recovery path

Completion policy:

- Do not promise guaranteed completion in all external conditions.
- Guarantee that the system does not intentionally stall.
- When progress degrades, force a strategy switch through recovery state transitions.

## 2. Core Principles

- Recovery-first over perfect first-run success
- Idempotent control points (lease, run claim, dedupe signatures)
- Backlog-first startup (clear existing work before creating new work)
- Explicit blocked reasons for machine recovery

## 3. Anti-Stall Mechanisms

### 3.1 Lease and Runtime Lock Discipline

- task lease prevents duplicate dispatch
- runtime lock prevents duplicate execution
- dangling/expired/orphaned lease paths are continuously reclaimed

### 3.2 Judge Idempotency

- only unjudged successful runs are eligible
- claimed run cannot be judged twice concurrently

### 3.3 Recovery States Instead of Halt States

- `awaiting_judge`
- `quota_wait`
- `needs_rework`

Additional runtime blocked state used for planner issue-link sequencing:

- `issue_linking`

State is transformed rather than abandoned.

### 3.4 Adaptive Escalation

- repeated same failure signatures trigger rework/autofix escalation
- merge-conflict approvals route to conflict autofix task when possible

### 3.5 Event-Driven Progress Recovery

Recovery switching is event-driven, not fixed-time-trigger driven.

- repeated failure signatures -> `needs_rework` / rework split
- non-approve circuit breaker -> autofix path
- quota failures -> `quota_wait` then cooldown requeue
- missing judgeable runs -> restore `awaiting_judge` run context

## 4. Quota Philosophy

Quota pressure is treated as recoverable external pressure, not terminal failure.

- attempt may fail quickly
- task is parked with explicit reason (`quota_wait`)
- cooldown retry continues until resources recover

## 5. Observability Requirements

Operators must see progress intent, not only attempt outcomes.

- run-level failures
- task-level next retry reason/time
- backlog gating reasons from preflight

## 6. Non-Goals

- maximizing first-attempt success at the cost of recoverability
- strict sequential processing when safe parallelism is available
- manual-only recovery flows
- fixed-minute watchdog automation as the primary recovery trigger
