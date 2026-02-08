# Operation Flow (Latest)

## 1. Main Loop

1. Start preflight checks the backlog
   - GitHub open issues / open PRs
   - Local `tasks` (queued/running/failed/blocked)
2. Preflight directly injects open issues as tasks (when needed)
3. Planner generates tasks only when there is requirement text and no issue backlog
4. Dispatcher selects a `queued` task, acquires a lease, and assigns it to a worker
5. Worker/Tester/Docser execute implementation and verification
6. On success, task transitions to `blocked(awaiting_judge)` and waits for Judge
7. Judge evaluates the run and moves it to `done` / `queued` / `blocked`
8. Cycle Manager performs stuck recovery, failed/blocked requeue, and metrics updates
9. Continue until all tasks are complete or stop conditions are met

## 1.1 Start preflight launch decisions

- Issue backlog exists:
  - Do not start Planner; prioritize issue-derived tasks
  - Start Dispatcher/Worker roles
- PR backlog exists:
  - Start Judge
- No backlog and only requirements exist:
  - Start Planner and follow the normal planning flow

## 2. Task Status Transitions

- `queued`
  - Waiting to run
- `running`
  - Dispatcher transitions after lease acquisition
- `blocked`
  - Waiting for Judge or rework
  - `blockReason`:
    - `awaiting_judge`
    - `needs_rework`
    - `needs_human`
- `failed`
  - Worker execution failed
- `done`
  - Completed after Judge approval
- `cancelled`
  - Aborted due to timeout or similar

Representative transitions:

- `queued -> running`
- `running -> blocked(awaiting_judge)`
- `blocked(awaiting_judge) -> done | queued | blocked(needs_*)`
- `failed -> queued | blocked`
- `blocked(needs_rework) -> failed + new rework task(queued)`

## 3. Run Lifecycle

- Create `runs` record with `running` when Worker starts
- On success, save `success` and `costTokens`
- On failure, save `failed` and `errorMessage`
- Judge targets only successful runs where `runs.judgedAt IS NULL`
- Atomic claim during Judge processing:
  - `judgedAt = now`
  - `judgementVersion = judgementVersion + 1`

This prevents re-reviewing the same run.

## 4. Dispatcher Parallel Control

- Do not execute tasks with unresolved dependencies
- Do not run tasks with conflicting `targetArea` concurrently
- Concurrency limit is `maxConcurrentWorkers - busyAgentCount`
  - Applies regardless of process/queue mode

## 5. Post-Judge Behavior

- `approve + merge success`:
  - Mark task as `done`
- `request_changes` / `needs_human`:
  - Default is requeue to `queued`
  - When requeue is disabled, keep `blocked(needs_rework|needs_human)`
- `approve but merge failed`:
  - Requeue to `queued` to avoid stalling

Notes:

- If a task has `context.issue.number`, Worker adds `Closes #<issue>` to the PR body
- This automatically links task results to issues on GitHub

## 6. Recovery

Cycle Manager periodically executes:

- Mark timeout runs as `cancelled`
- Return orphaned `running` tasks to `queued`
- Classification-based retries for failed tasks
- Reason-based handling for blocked tasks
  - `awaiting_judge`: requeue if there is no pending judge run
  - `needs_rework`: generate split tasks
  - `needs_human`: isolate (no automatic retry)

## 7. Failure Classification (Adaptive Retry)

Failures are classified to adjust retry strategy.

- `env`
- `setup`
- `policy`
- `test`
- `flaky`
- `model`

This prevents blind repetition of the same cause and moves to `blocked` when limits are reached.

## 8. SLOs and Observability

- SLO1: `queued -> running` within 5 minutes
- SLO2: Do not leave `blocked` beyond 30 minutes
- SLO3: Visualize retry exhaustion

Dashboard Overview shows:

- `QUEUE AGE MAX`
- `BLOCKED > 30M`
- `RETRY EXHAUSTED`
