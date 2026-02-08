# Principles of Non-Human Operation

## 1. Goal

Sustain long-running, parallel execution without human intervention.

The goal is evaluated by three criteria:

- Never stall
- Keep recovering by changing strategy for repeated failures
- Never break under parallelism

## 2. Design Principles

- Role separation
  - Separate Planner / Dispatcher / Worker / Judge / Cycle Manager
- Mechanized judgement
  - Transitions decided by `commands`, policy, CI, and Judge verdict
- Recovery-first
  - Automatically handle failed / blocked / orphan / timeout
- Idempotency
  - Never evaluate the same run twice
  - Never execute the same task twice

## 3. Primary Anti-Stall Mechanisms

### 3.1 Judge idempotency

- Use `runs.judgedAt` and `judgementVersion` to prevent re-judging the same run
- Do not re-review claimed runs

### 3.2 Blocked control by blockReason

- `awaiting_judge`
- `needs_rework`
- `needs_human`

Separate behavior by reason to prevent stalling while isolating risky operations.

### 3.3 Adaptive retries

Failure classification:

- `env/setup/policy/test/flaky/model`

Adjust retry limits per category to switch recovery strategy without stopping.

### 3.4 Unified parallel control

- Concurrency is based on busy agent count
- Avoid `targetArea` collisions
- Lease + orphan recovery

## 4. SLO

- `queued -> running` within 5 minutes
- Do not leave `blocked` beyond 30 minutes
- Visualize recovery escalation

## 5. Boundary of Human Intervention

Automation does not stop; it changes recovery strategies when needed:

- Persistent `needs_human` or policy violations trigger rework/splitting rather than halting
- External dependency failures are isolated but still retried with recovery context

## 6. Operational Notes

- Keep verify non-destructive
  - Do not rewrite `package.json` just for verification
- Stop denylisted commands with double defense
  - Before verify + before OpenCode execution
- Store logs per task/run and reuse as context for the next retry
