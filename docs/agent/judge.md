# Judge Agent

## 1. Role

Evaluate successful runs and transition tasks to done or recovery paths that keep execution moving.

## 2. Inputs

- Run (`status=success`)
- PR info (git mode) or local diff (local mode)
- CI/policy/LLM evaluation results

Launch triggers (Start preflight):

- There is a GitHub open PR
- Or there is a `blocked(awaiting_judge)` task backlog

## 3. Verdicts

- `approve`
- `request_changes`
- `needs_human`

## 4. Key Specifications

- Idempotency:
  - Only runs with `runs.judgedAt IS NULL`
  - Increment `judgementVersion` on claim
- Target tasks:
  - Only `status=blocked`
- On non-approval:
  - Default is requeue to `queued`
  - When requeue is disabled, Cycle Manager still recovers via `needs_rework` or `awaiting_judge`
- Approve but merge fails:
  - Requeue to avoid stalling

## 5. Main Settings

- `JUDGE_MODE=git|local|auto`
- `JUDGE_MODEL`
- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT`

## 6. Outputs

- Write review/requeue records to `events`
- Update run (including failure reasons)
- Update task (`done`/`queued`/`blocked`)
- Create docser tasks when needed
