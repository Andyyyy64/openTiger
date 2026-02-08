# Judge Agent

## 1. Role

Evaluate successful implementation runs and drive state transitions toward merge completion.

## 2. Inputs

- successful run + artifacts (`pr`/`worktree`)
- CI / policy / LLM evaluator summary
- current task state and retry context

## 3. Core Decisions

- `approve`
- `request_changes`

(legacy `needs_human` is treated as request-changes-style recovery behavior.)

## 4. Post-Decision Actions

- approve + merge success -> task `done`
- non-approve -> requeue or escalate (`needs_rework` + autofix)
- approve but merge not completed:
  - conflict signals -> queue `[AutoFix-Conflict]`
  - otherwise schedule judge retry path

## 5. Anti-Loop Mechanics

- claim-run idempotency (`judgedAt` / `judgementVersion`)
- non-approve circuit breaker -> AutoFix escalation
- doom-loop detector -> AutoFix escalation
- awaiting-judge backlog restoration for missing pending runs

## 6. Important Settings

- `JUDGE_MODE`
- `JUDGE_MODEL`
- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`
- `JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES`
- local mode recovery settings (`JUDGE_LOCAL_BASE_REPO_RECOVERY*`)
