# Implementation Status and Risks

## 1. Implemented (Aligned With Current Code)

- Preflight backlog-aware startup decisions
- Open issue -> task import flow
- Open PR -> judge backlog import flow
- Planner dedupe by signature + advisory transaction lock
- Planner process duplicate-start guard
- Worker quota detection -> `blocked(quota_wait)`
- Dispatcher cooldown excludes latest quota failures
- Dispatcher lease/orphan cleanup loop
- Busy slot calculation excludes judge/planner (`worker/tester/docser` only)
- Judge idempotent claim and run restoration paths
- Judge non-approve circuit breaker to AutoFix
- Judge approve+merge-conflict branch to `AutoFix-Conflict`
- Cycle Manager blocked/failed cooldown requeue and rework split creation
- Queue lock/stalled settings tuned for faster crash recovery

## 2. Current Operational Risks

- Planner still depends on LLM inspection success in strict mode.
  - Under long quota outages, planning may abort instead of producing fallback plan.
- External permission prompts (workspace boundary) can still cause deterministic failure categories.
- Large PR backlog can dominate judge cycles and delay fresh implementation tasks by design.

## 3. Active Recovery Guarantees

- Services are restartable and recoverable without wiping DB.
- Failed attempts are transformed into retryable task states.
- Blocked reasons are machine-actionable and continuously revisited.

## 4. Recommended Validation Before Release

- Run 24h soak with simulated quota pressure.
- Verify no task remains in the same blocked reason beyond policy window without state transitions.
- Verify preflight reasons match actual startup actions.
- Verify duplicate worker startup does not create duplicate runs.
