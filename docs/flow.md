# Execution Flow (Current)

## Scope

This page describes **runtime state transitions** for task/run.  
For startup preflight rules and full pattern matrix, see `docs/startup-patterns.md`.

## 0.1 Entry Point from State Model

When entering from state vocabulary, first fix terminology in `docs/state-model.md`, then check transitions and recovery paths here.

| State model section                     | Next section here                                                            | Owning agent                |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| "1. Task Status" "2. Task Block Reason" | "2. Basic Lifecycle" "3. Blocked Reasons Used for Recovery"                  | Dispatcher / Worker / Judge |
| "2.2 Task Retry Reason (Operations)"    | "6. Worker Failure Handling" "8. Cycle Manager Self-Recovery"                | Worker / Cycle Manager      |
| "7. Patterns Prone to Stalls"           | "5. Dispatcher Recovery Layer" "7. Judge Non-Approval / Merge Failure Paths" | Dispatcher / Judge          |

## 1. Startup / Preflight

On system startup, call `/system/preflight` to build recommended startup configuration.

Inputs:

- Requirement content
- GitHub open issues
- GitHub open PRs
- Local task backlog (`queued`/`running`/`failed`/`blocked`)

Rules:

- `startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog`
- Execution agents (`dispatcher`/`worker`/`tester`/`docser`) start when planner work or backlog exists
- Judge starts when judge backlog exists or execution agents are active
- Planner process count is max 1

Meaning of common warnings:

- `Issue backlog detected (...)`
  - Backlog-first mode is active
- `Planner is skipped for this launch`
  - Normal when issue/pr backlog exists

Exact formulas and all combinations are in `docs/startup-patterns.md`.

## 2. Basic Lifecycle

1. Task enters `queued`
2. Dispatcher acquires lease and moves task to `running`
3. Execution role (`worker`/`tester`/`docser`) runs task and verification commands
   - For `tasks.kind=research`, worker runs non-git research path (`plan/collect/challenge/write`)
   - For `tasks.kind=code`, normal git-based implementation path is used
   - Before LLM execution, worker builds compressed prompt context from:
     - Static instructions (`apps/worker/instructions/*.md`)
     - Runtime snapshot (`.opentiger/context/agent-profile.json`)
     - Failure delta (`.opentiger/context/context-delta.json`)
   - Context injection uses a fixed character budget to avoid prompt bloat
4. On success:
   - Usually `blocked(awaiting_judge)` if review needed
   - Otherwise `done`
5. Judge evaluates successful run
6. Task transitions to:
   - `done`
   - `blocked(awaiting_judge)` (retry/recovery)
   - `blocked(needs_rework)` (split/autofix path)
7. Cycle Manager continues requeue / rebuild until convergence

## 3. Blocked Reasons Used for Recovery

Definitions are in `docs/state-model.md`.

- `awaiting_judge`
  - Successful run exists but not judged, or run restore needed
- `quota_wait`
  - Worker detected LLM quota error; waiting for cooldown retry
- `needs_rework`
  - Non-approve escalation, repeated failure signature, or explicit autofix path

Legacy `needs_human` is normalized into valid recovery paths.

Other runtime blocked reasons:

- `issue_linking`
  - Planner temporarily holds task for issue-link metadata; returns to `queued` when resolved

## 4. Run Lifecycle and Judge Idempotency

- Worker creates `runs(status=running)` at start
- Worker updates run to `success`/`failed`
- Judge only processes unjudged successful runs
- Judge atomically claims run before review (`judgedAt`, `judgementVersion`)

Result:

- Prevents double review of same run
- Suppresses duplicate judge loops

## 5. Dispatcher Recovery Layer

Each poll loop:

- Clean up expired leases
- Clean up dangling leases
- Reclaim dead-agent leases
- Recover orphaned `running` tasks with no active run

Task filter conditions:

- Unresolved dependencies blocked
- `targetArea` conflict blocked
- Recent non-quota failure subject to cooldown block
- Latest quota failure excluded from dispatcher cooldown block

## 6. Worker Failure Handling

On task error:

- Update run to `failed`
- Update task:
  - If matches quota signature: `blocked(quota_wait)`
  - Otherwise: `failed`
- Optionally update context delta (`.opentiger/context/context-delta.json`) by failure signature
- Release lease
- Return agent to `idle`

Queue duplicate prevention:

- Per-task runtime lock
- Post-start guard on lock conflict (avoids wrong immediate requeue)

## 7. Judge Non-Approval / Merge Failure Paths

- Non-approval may create AutoFix task and move parent to `blocked(needs_rework)`
- On approval, merge conflict may generate `[AutoFix-Conflict] PR #...`
- On conflict autofix enqueue failure, uses judge retry fallback

## 8. Cycle Manager Self-Recovery

Main periodic actions:

- Cancel timeout runs
- Lease cleanup
- Reset offline agents
- Cooldown requeue of failed tasks (with failure classification; unsupported/missing verification command goes to command adjustment, not block)
- Reason-specific cooldown recovery for blocked tasks
- Backlog ordering gate
  - `local task backlog > 0`: continue task execution
  - `local task backlog == 0`: call `/system/preflight` to import/sync issue backlog
  - `issue backlog == 0`: trigger Planner replan

For startup vs replan responsibility split, see `docs/startup-patterns.md`.

Blocked recovery behavior:

- `awaiting_judge`
  - If pending judge run exists, keep `blocked(awaiting_judge)`
  - If no pending run, try restoring latest judgable successful run
  - If no run can be restored:
    - Judge-review task: requeue to `queued` (`awaiting_judge_missing_run_retry`)
    - Other task: timeout requeue to `queued` (`awaiting_judge_timeout_retry`)
- `quota_wait`
  - Requeue after cooldown
- `needs_rework`
  - Judge-review task:
    - Pending/restorable judge run exists -> `blocked(awaiting_judge)`
    - Missing judge run -> requeue to `queued` (`pr_review_needs_rework_missing_run_retry`)
  - `setup_or_bootstrap_issue`: in-place requeue from blocked with setup retry limit
  - Normal task: create `[Rework] ...` task, move parent to failed lineage
  - Policy-only violation: may in-place requeue after `allowedPaths` adjustment. If no safe path, suppress rework split (cancel after retry limit)
  - Do not create additional rework if valid rework child already exists
  - Cancel when rework depth exceeds `AUTO_REWORK_MAX_DEPTH`

System process self-recovery:

- Self-heal starts managed processes only while runtime hatch is armed
- Judge backlog alone does not arm runtime hatch

Policy lifecycle and self-growth details:

- `docs/policy-recovery.md`
- `docs/verify-recovery.md`

## 9. Host Snapshot and Context Update

- API host context endpoints:
  - `GET /system/host/neofetch`
  - `GET /system/host/context`
- Main snapshot source is `neofetch`; falls back to `uname -srmo` when needed
- Snapshot cached in `.opentiger/context/agent-profile.json`, updated by TTL/fingerprint

## 10. Why `Failed` and `Retry` Coexist

Runs table may show immediate `failed` while task card shows retry countdown.

Example:

- run status: `failed` (actual result of that attempt)
- task retry: `quota 79s` (next recovery attempt already scheduled)

This indicates active recovery, not a halt.

## Related Agent Specifications

- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/docser.md`
- `docs/agent/judge.md`
- `docs/agent/cycle-manager.md`

To trace implementation, use the "Implementation reference (source of truth)" section at the end of each page to locate the corresponding `apps/*/src`.

## 11. TigerResearch Lifecycle (Planner-First)

1. `POST /plugins/tiger-research/jobs` creates a research job and requests planner start with `researchJobId`
2. Planner decomposes query into claims and enqueues claim-level `collect` tasks
3. Dispatcher runs those tasks in parallel (`tasks.kind=research`)
4. Worker persists claims/evidence/report artifacts in TigerResearch plugin tables
5. Cycle Manager orchestrates stage transitions:
   - `planning` -> `collecting` -> `challenging` -> `composing` -> `judging`/`reworking`
6. Judge (if `RESEARCH_REQUIRE_JUDGE=true`) applies research verdict:
   - pass: task/job converge to `done`
   - fail: task blocked as `needs_rework`
7. Cycle Manager creates targeted rework tasks until quality gate convergence or blocked terminal condition

Fallback behavior:

- If planner cannot be started on job creation, API enqueues a fallback `plan` task.
- While `plannerPendingUntil` is active, cycle manager waits before fallback plan task injection.
