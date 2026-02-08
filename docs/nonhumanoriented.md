# Principles of Non-Human Operation

## 1. Goal

Sustain long-running, parallel execution without human intervention.

The goal is evaluated by three criteria:

- Never stall
- Never repeat the same failure endlessly
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

Adjust retry limits per category to stop blind retries.

### 3.4 Unified parallel control

- Concurrency is based on busy agent count
- Avoid `targetArea` collisions
- Lease + orphan recovery

## 4. SLO

- `queued -> running` within 5 minutes
- Do not leave `blocked` beyond 30 minutes
- Visualize retry exhaustion

## 5. Boundary of Human Intervention

Conditions to stop automation:

- High-risk changes with persistent `needs_human`
- Repeated policy violations
- External dependencies (auth/infra) that cannot be resolved automatically

Conditions to keep automation running:

- Flaky or transient failures
- Temporary errors like merge API failures

## 6. Operational Notes

- Keep verify non-destructive
  - Do not rewrite `package.json` just for verification
- Stop denylisted commands with double defense
  - Before verify + before OpenCode execution
- Store logs per task/run and reuse as context for the next retry
