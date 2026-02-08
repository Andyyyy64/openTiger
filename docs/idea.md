# Next Ideas

## 1. Planner Fallback Layer

- Add optional "degraded planning" mode when inspection repeatedly fails.
- Generate minimal safe tasks instead of hard aborting planning.

## 2. Recovery Explainability

- Add first-class timeline panel: state transition graph per task.
- Show reason evolution (`quota_wait -> queued -> running -> awaiting_judge`).

## 3. Judge Throughput Controls

- Dynamic judge scaling based on awaiting backlog slope.
- Prioritize PRs with oldest blocked parent task first.

## 4. Retry Policy Profiles

- profile-based retry policy (`aggressive`, `balanced`, `cost-save`).
- allow per-project overrides by config row.

## 5. Safety Hardening

- stronger permission preflight for expected external paths.
- explicit validation before passing paths to worker instructions.
