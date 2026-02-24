# Execution Flow (Current)

This page describes **runtime state transitions** for task/run.  
For startup preflight rules and full pattern matrix, see [startup-patterns](startup-patterns.md).

## Table of Contents

- [0.1 Entry Point from State Model](#01-entry-point-from-state-model)
- [1. Startup / Preflight](#1-startup--preflight)
- [2. Basic Lifecycle](#2-basic-lifecycle)
- [3. Blocked Reasons Used for Recovery](#3-blocked-reasons-used-for-recovery)
- [4. Run Lifecycle and Judge Idempotency](#4-run-lifecycle-and-judge-idempotency)
- [5. Dispatcher Recovery Layer](#5-dispatcher-recovery-layer)
- [6. Worker Failure Handling](#6-worker-failure-handling)
- [7. Judge Non-Approval / Merge Failure Paths](#7-judge-non-approval--merge-failure-paths)
- [8. Cycle Manager Self-Recovery](#8-cycle-manager-self-recovery)
- [9. Host Snapshot and Context Update](#9-host-snapshot-and-context-update)
- [10. Why `Failed` and `Retry` Coexist](#10-why-failed-and-retry-coexist)
- [Related Agent Specifications](#related-agent-specifications)
- [11. TigerResearch Lifecycle (Planner-First)](#11-tigerresearch-lifecycle-planner-first)
- [13. Chat Conversational Flow](#13-chat-conversational-flow)

## 0.1 Entry Point from State Model

When entering from state vocabulary, first fix terminology in [state-model](state-model.md), then check transitions and recovery paths here.

| State model section                     | Next section here                                                                                                                                       | Owning agent                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| "1. Task Status" "2. Task Block Reason" | [2. Basic Lifecycle](#2-basic-lifecycle), [3. Blocked Reasons Used for Recovery](#3-blocked-reasons-used-for-recovery)                                  | Dispatcher / Worker / Judge |
| "2.2 Task Retry Reason (Operations)"    | [6. Worker Failure Handling](#6-worker-failure-handling), [8. Cycle Manager Self-Recovery](#8-cycle-manager-self-recovery)                              | Worker / Cycle Manager      |
| "7. Patterns Prone to Stalls"           | [5. Dispatcher Recovery Layer](#5-dispatcher-recovery-layer), [7. Judge Non-Approval / Merge Failure Paths](#7-judge-non-approval--merge-failure-paths) | Dispatcher / Judge          |

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

Exact formulas and all combinations are in [startup-patterns](startup-patterns.md).

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
   - `github`/`local-git` mode: usually `blocked(awaiting_judge)` if review needed
   - `direct` mode: tasks transition directly to `done` (no judge review)
   - Otherwise `done`
5. Judge evaluates successful run (skipped in `direct` mode)
6. Task transitions to:
   - `done`
   - `blocked(awaiting_judge)` (retry/recovery)
   - `blocked(needs_rework)` (split/autofix path)
7. Cycle Manager continues requeue / rebuild until convergence

## 3. Blocked Reasons Used for Recovery

Definitions are in [state-model](state-model.md).

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
- On approval, merge retries are handled by `pr_merge_queue` (not same-run re-judgement)
- Queue lifecycle:
  - `pending` -> `processing` (claim)
  - `processing` -> `merged` (task `done`) or `pending` (retry with backoff)
  - `processing` -> `failed` (attempt budget exhausted)
- Conflict recovery (`[AutoFix-Conflict]` / `[Recreate-From-Main]`) is triggered only after merge queue exhaustion
- Stale queue claims are recovered by Judge and Cycle Manager cleanup paths

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

For startup vs replan responsibility split, see [startup-patterns](startup-patterns.md).

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

- [policy-recovery](policy-recovery.md)
- [verify-recovery](verify-recovery.md)

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

- [agent/planner](agent/planner.md)
- [agent/dispatcher](agent/dispatcher.md)
- [agent/worker](agent/worker.md)
- [agent/tester](agent/tester.md)
- [agent/docser](agent/docser.md)
- [agent/judge](agent/judge.md)
- [agent/cycle-manager](agent/cycle-manager.md)

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

## 12. Plugin Hook Flow (Manifest v1)

All plugin runtime behavior is driven by `PluginManifestV1` loaded by `packages/plugin-sdk`.

1. Startup loader phase
   - Read available plugin manifests
   - Validate `pluginApiVersion`
   - Resolve `requires` order
   - Build enabled plugin registry from `ENABLED_PLUGINS`
2. API phase
   - Mount plugin routes under `/plugins/<plugin-id>/*`
   - Expose plugin inventory/status through `GET /plugins`
3. Planner/Dispatcher/Worker/Judge/Cycle phase
   - Resolve hooks from shared registry
   - Execute plugin-specific behavior without hardcoded plugin id checks
4. Dashboard phase
   - Discover route modules via `import.meta.glob`
   - Apply enabled-filter to nav/routes at startup
5. DB phase
   - Apply core migrations
   - Apply plugin migrations in dependency order

Failure handling:

- Incompatible plugin manifest -> `incompatible` status, plugin skipped, core continues
- Plugin load/runtime initialization error -> `error` status with explicit reason

## 13. Chat Conversational Flow

The chat interface provides a conversational path from requirement to execution.

Phase progression: `greeting` → `requirement_gathering` → `plan_proposal` → `execution` → `monitoring`

### 13.1 Requirement to Plan

1. User sends message describing what they want to build
2. LLM generates a plan autonomously (minimal clarification questions)
3. When plan is complete, LLM appends `---PLAN_READY---` marker
4. Backend detects marker, strips it from saved content, inserts `mode_selection` system message
5. Conversation phase transitions to `plan_proposal`

### 13.2 Plan to Execution

1. UI renders mode selection card (Direct / Local Git / GitHub)
2. User selects execution mode via `POST /chat/conversations/:id/start-execution`
3. Backend updates global config, sets conversation to `execution` phase
4. Frontend triggers preflight → process startup (planner, dispatcher, workers, judge, cycle-manager)

### 13.3 SSE Streaming

LLM responses are streamed via Server-Sent Events:

1. `POST /messages` starts LLM execution and returns immediately
2. Chunks are buffered in an in-memory session (`chat-state.ts`)
3. `GET /stream` replays buffered chunks, then listens for new events
4. Terminal events: `done` (success) or `error` (failure)
5. Session cleanup after 60s post-completion

### 13.4 Implementation Reference

- `apps/api/src/routes/chat.ts` — endpoints
- `apps/api/src/routes/chat-orchestrator.ts` — phase resolution, system prompts
- `apps/api/src/routes/chat-state.ts` — SSE session management
- `packages/llm/src/chat/chat-executor.ts` — LLM process execution
- `apps/dashboard/src/pages/Chat.tsx` — frontend orchestration
- `apps/dashboard/src/lib/chat-api.ts` — API client and SSE subscriber
