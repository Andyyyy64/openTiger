# Future Ideas

## 1. Planner Fallback Layer

- Add optional `degraded planning` mode for continuous inspection failures
- Avoid hard abort of planning; generate minimal safe tasks

## 2. Recovery Explainability

- Add task-level state transition timeline panel as first-class feature
- Visualize reason changes (`quota_wait -> queued -> running -> awaiting_judge`)

## 3. Judge Throughput Controls

- Dynamically scale judge count based on awaiting backlog trend
- Prioritize evaluation of PRs with oldest blocked parent task

## 4. Retry Policy Profiles

- Add profile-based retry policy (`aggressive`, `balanced`, `cost-save`)
- Allow project-level override per config row

## 5. Safety Hardening

- Strengthen preflight permission check for unexpected external paths
- Add explicit validation before passing paths to worker instructions

## 6. Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, When Evaluating Ideas)

When trying improvements, checking impact in order state vocabulary -> transition -> owner -> implementation helps compare:

1. `docs/state-model.md` (how state vocabulary changes)
2. `docs/flow.md` (what transition/recovery differences appear)
3. `docs/operations.md` (whether API check procedures need updates)
4. `docs/agent/README.md` (impact on owning agent and implementation responsibilities)
