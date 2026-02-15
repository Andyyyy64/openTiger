# Non-Human-First Operation Principles

## 1. Purpose

To continuously make progress autonomously without constant human monitoring.

Practical definition:

- No silent deadlocks
- No infinite loops on the same step with no state change
- Repeated failures always converted to a different recovery path

Completion policy:

- Don't assume completion guarantee for all cases including external conditions
- Guarantee that the system does not intentionally stay stopped
- When progress degrades, force strategy change via recovery state transition

## 2. Core Principles

- Recovery-first over first-attempt success
- Idempotent control points (lease / run claim / dedupe signature)
- Backlog-first startup (prioritize consuming existing backlog over new generation)
- Explicit blocked reasons that are machine-recoverable

## 3. Stall-Prevention Mechanisms

### 3.1 Lease and Runtime Lock Discipline

- Task lease prevents duplicate dispatch
- Runtime lock prevents duplicate execution
- Continuously reclaim dangling / expired / orphaned leases

### 3.2 Judge Idempotency

- Only unjudged successful runs are processed
- Claimed runs cannot be double-judged

### 3.3 Use Recovery State Instead of Halt State

- `awaiting_judge`
- `quota_wait`
- `needs_rework`

Runtime blocked state for planner issue-link ordering:

- `issue_linking`

Convert state to recoverable, never abandon it.

### 3.4 Adaptive Escalation

- Escalate to rework/autofix on repeated same failure signature
- On merge conflict after approve, branch to conflict autofix task when possible

### 3.5 Event-Driven Progress Recovery

Recovery switch is event-driven, not fixed-time triggered:

- Repeated same failure signature -> `needs_rework` / rework split
- Non-approve circuit breaker -> autofix path
- Quota failure -> `quota_wait` -> cooldown requeue
- Missing judgable run -> restore `awaiting_judge` run context

## 4. Quota Philosophy

Treat quota pressure as recoverable external pressure, not terminal failure.

- Single attempt may fail quickly
- Task waits with explicit reason (`quota_wait`)
- Continue cooldown retry until resources recover

## 5. Observability Requirements

Operators must observe not only trial results but also intended next steps:

- Run-level failure
- Task-level next retry reason/time
- Backlog gate reason returned by preflight

## 6. Non-Goals

- Maximizing first-attempt success at cost of recoverability
- Fixed strict sequential processing when safe concurrency exists
- Recovery flows that require manual intervention only
- Recovery design that relies only on fixed-interval watchdog

## 7. Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation)

This page describes design principles; for actual triage, follow state vocabulary -> transition -> owner -> implementation.

1. [state-model](state-model.md) (state vocabulary)
2. [flow](flow.md) (transitions and recovery paths)
3. [operations](operations.md) (API procedures and operation shortcuts)
4. [agent/README](agent/README.md) (owning agent and implementation tracing)
