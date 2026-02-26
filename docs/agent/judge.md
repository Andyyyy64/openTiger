# Judge Agent Specification

Related:

- [README](README.md)
- [flow](../flow.md)
- [mode](../mode.md)

## 1. Role

Judge evaluates successful runs and decides whether to converge tasks to `done` or branch to re-execution/rework.

Out of scope:

- Queued task dispatch and lease management
- Direct file modification execution

## 2. Mode Resolution

Execution mode is determined by:

- `JUDGE_MODE=github|local-git|direct|auto`
- When `auto`, it follows `REPO_MODE`
- `direct` mode: auto-approve loop clears stuck `awaiting_judge` tasks without LLM evaluation

## 3. Input

- Successful run + artifacts (`pr` / `worktree`)
- CI / policy / LLM evaluator results
- Task retry context / lineage
- Successful research runs (`tasks.kind=research`) in write stage

## 4. Core Decisions

- `approve`
- `request_changes`

Legacy `needs_human` is normalized into request_changes-style recovery flow.

## 5. Post-Decision Transitions

- approve + merge success -> `done`
- approve + merge incomplete -> enqueue `pr_merge_queue` and keep task `blocked(awaiting_judge)`
- non-approve -> retry or move to `needs_rework`
- merge queue exhaustion -> conflict recovery escalation (`[AutoFix-Conflict]` / `[Recreate-From-Main]`)

Research decision path:

- approve -> mark research task `done`, update research job status/metadata
- request_changes -> set `blocked(needs_rework)`, cycle manager orchestrates targeted rework

## 6. Loop Prevention and Recovery

- Idempotent run claim control (`judgedAt`, `judgementVersion`)
- Merge-incomplete paths do not reset `runs.judgedAt`; only explicit run restoration does
- Merge queue claim lease recovery (`processing -> pending` on claim timeout)
- Non-approve circuit breaker
- Doom loop circuit breaker
- Run restoration for awaiting_judge backlog
- Conflict autofix/recreate are gated behind merge queue retry budget

## 7. Implementation Reference (Source of Truth)

- Startup and loop: `apps/judge/src/main.ts`, `apps/judge/src/judge-loops.ts`
- Core decision logic: `apps/judge/src/judge-agent.ts`, `apps/judge/src/judge-evaluate.ts`
- Retry and recovery: `apps/judge/src/judge-retry.ts`, `apps/judge/src/judge-pending.ts`
- Autofix path: `apps/judge/src/judge-autofix.ts`
- Local operation path: `apps/judge/src/judge-local-loop.ts`, `apps/judge/src/judge-local-merge.ts`
- Direct mode auto-approve loop: `apps/judge/src/judge-direct-loop.ts`
- Research evaluator: `apps/judge/src/judge-research.ts`

## 8. Main Configuration

- `JUDGE_MODE`
- `JUDGE_MODEL`
- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`
- `JUDGE_AUTO_FIX_ON_FAIL`
- `JUDGE_AUTO_FIX_MAX_ATTEMPTS`
- `JUDGE_AWAITING_RETRY_COOLDOWN_MS`
- `JUDGE_MERGE_QUEUE_MAX_ATTEMPTS`
- `JUDGE_MERGE_QUEUE_RETRY_DELAY_MS`
- `JUDGE_MERGE_QUEUE_CLAIM_TTL_MS`
- `JUDGE_PR_MERGEABLE_PRECHECK_RETRIES`
- `JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS`
- `JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES`
- `JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY*`
- `JUDGE_RESEARCH_MIN_CLAIMS`
- `JUDGE_RESEARCH_MIN_EVIDENCE_PER_CLAIM`
- `JUDGE_RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM`
- `JUDGE_RESEARCH_REQUIRE_COUNTER_EVIDENCE`
- `JUDGE_RESEARCH_MIN_CONFIDENCE`
- `JUDGE_RESEARCH_MIN_VERIFIABLE_RATIO`
- `RESEARCH_REQUIRE_JUDGE`
