# Operation Flow (Current)

## 1. Start / Preflight

System start calls `/system/preflight` and builds a recommendation.

Inputs checked:

- requirement content
- GitHub open issues
- GitHub open PRs
- local task backlog (`queued/running/failed/blocked`)

Decision rules:

- `startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog`
- execution agents (`dispatcher/worker/tester/docser`) start when there is planner work or backlog
- judge starts when judge backlog exists or execution agents are active
- planner process count is capped at 1

Meaning of common warnings:

- `Issue backlog detected (...)`
  - backlog-first mode is active
- `Planner is skipped for this launch`
  - expected when issue/pr backlog exists

## 2. Primary Lifecycle

1. Task in `queued`
2. Dispatcher acquires lease and sets task `running`
3. Executable role (`worker/tester/docser`) executes task and verify commands
   - before LLM execution, worker builds compact prompt context from:
     - static instructions (`apps/worker/instructions/*.md`)
     - runtime snapshot (`.opentiger/context/agent-profile.json`)
     - failure delta (`.opentiger/context/context-delta.json`)
   - context injection uses a fixed character budget to avoid prompt bloat
4. On success:
   - usually `blocked(awaiting_judge)` if review is needed
   - `done` for direct/no-review completion
5. Judge evaluates successful run
6. Task moves to:
   - `done`
   - `blocked(awaiting_judge)` (retry/recovery)
   - `blocked(needs_rework)` (split/autofix path)
7. Cycle Manager continuously requeues/rebuilds until convergence

## 3. Blocked Reasons Used in Recovery

- `awaiting_judge`
  - successful run exists but not judged yet, or run restoration is needed
- `quota_wait`
  - worker detected LLM quota error and parked task for cooldown retry
- `needs_rework`
  - non-approve escalation, repeated failure signature, or explicit autofix path

Legacy `needs_human` is normalized into active recovery paths for compatibility.

Other runtime blocked reason:

- `issue_linking`
  - planner temporarily parks a task until issue-link metadata is resolved, then returns it to `queued`

## 4. Run Lifecycle and Judge Idempotency

- Worker creates `runs(status=running)` at start
- Worker updates run to `success/failed`
- Judge only targets successful unjudged runs
- Judge claims run atomically (`judgedAt`, `judgementVersion`) before review

Result:

- same run is not reviewed twice
- duplicated judge loops are constrained

## 5. Dispatcher Recovery Layer

Per poll loop:

- cleanup expired leases
- cleanup dangling leases
- reclaim dead-agent leases
- recover orphaned `running` tasks without active run

Task filtering:

- unresolved dependencies are blocked
- `targetArea` collisions are blocked
- recent non-quota failures can be cooldown-blocked
- latest quota failures are excluded from dispatcher cooldown blocking

## 6. Worker Failure Handling

On task error:

- run marked `failed`
- task marked:
  - `blocked(quota_wait)` for quota signatures
  - `failed` otherwise
- failure signature may update context delta (`.opentiger/context/context-delta.json`)
- lease released
- agent returned to `idle`

Queue duplicate protection:

- runtime lock per task
- startup-window guard for lock conflicts (avoid false immediate requeue)

## 7. Judge Non-Approve and Merge-Failure Paths

- Non-approve can trigger AutoFix task creation and parent task -> `blocked(needs_rework)`
- Approve but merge conflict can trigger `[AutoFix-Conflict] PR #...`
- If conflict autofix enqueue fails, judge retry fallback is used

## 8. Cycle Manager Self-Healing

Periodic jobs include:

- timeout run cancellation
- lease cleanup
- offline agent reset
- failed task cooldown requeue (with failure classification; unsupported/missing verification commands trigger command adjustment instead of block)
- blocked task cooldown recovery by reason
- backlog ordering gate
  - `local task backlog > 0`: keep executing tasks
  - `local task backlog == 0`: run `/system/preflight` to import/sync issue backlog
  - `issue backlog == 0`: trigger planner replan

Blocked recovery behavior:

- `awaiting_judge`
  - restore latest successful judgeable run if needed
  - otherwise timeout-requeue (PR review tasks stay `awaiting_judge` to avoid ping-pong)
- `quota_wait`
  - cooldown then requeue
- `needs_rework`
  - for PR review tasks: route back to `awaiting_judge`
  - for normal tasks: generate `[Rework] ...` task and move parent to failed lineage
  - policy-only violations can be requeued in-place with adjusted `allowedPaths`; if no safe path exists, rework split is suppressed (with retry limit, then cancel)
  - skip rework if active rework child already exists
  - cancel if rework depth exceeds `AUTO_REWORK_MAX_DEPTH`

System process self-heal:

- Judge backlog detected (`openPrCount > 0` or `pendingJudgeTaskCount > 0`) arms runtime hatch and auto-starts Judge process when down

Detailed policy lifecycle and growth behavior:

- `docs/policy-recovery.md`

## 9. Host Snapshot and Context Refresh

- API host context endpoints:
  - `GET /system/host/neofetch`
  - `GET /system/host/context`
- Snapshot source is `neofetch`; `uname -srmo` is used as fallback when needed.
- Snapshot is cached in `.opentiger/context/agent-profile.json` with TTL/fingerprint refresh.

## 10. Why "Failed" and "Retry" Can Coexist

Runs table can show immediate failed runs while task card shows retry countdown.

Example:

- run status: `failed` (actual attempt outcome)
- task retry: `quota 79s` (next recovery attempt is already scheduled)

This is active recovery, not a dead stop.

## 関連する Agent 仕様

- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/docser.md`
- `docs/agent/judge.md`
- `docs/agent/cycle-manager.md`
