# Planner Agent Specification

Related:

- [README](README.md)
- [flow](../flow.md)
- [verification](../verification.md)

## 1. Role

Planner generates executable task sets from requirement/issue and persists them without duplication.  
To avoid duplicate plans, operation assumes a single instance.

Out of scope:

- Task execution (code changes, verification command execution)
- Run artifact judge decisions

## 2. Input

- Requirement content/file
- Existing backlog and dependency info
- Judge feedback / failure hints
- Repository inspection results
- Policy recovery hints (from past events)
- Research query/job (`--research-job <id>`)

## 3. Processing Pipeline

1. Requirement parsing and validation
2. Load existing context (feedback/hints)
3. Run inspection (LLM)
4. Task generation (LLM + fallback path)
5. Dependency normalization
6. Apply role / allowedPaths / command policy
7. Verification command augmentation
8. Hot-file overlap detection against active backlog (`queued/running/blocked`)
9. Save plan (with dedupe lock)
10. Link to issue when needed

## 4. Main Behavior

- Init task injection for uninitialized repositories
- Cycle/redundancy removal in dependency index
- Automatic lockfile path allowance
- Command-driven allowedPaths completion
- Doc gap detection and docser task injection
- Reflect policy recovery hints into future tasks
- Attach backlog-overlap dependencies before persistence to reduce hot-file collisions
- Save plan summary in `planner.plan_created` event

Research mode behavior:

- Run planner-first decomposition from `research_jobs.query`
- Generate atomic claims with fallback when decomposition fails
- Persist `research_claims`
- Enqueue initial `collect` tasks (`tasks.kind=research`)
- Update orchestrator metadata (`plannedAt`, `claimCount`, warnings)

## 5. Verification Command Augmentation

Planner can augment verification commands at task generation time.

- `PLANNER_VERIFY_COMMAND_MODE=off|fallback|contract|llm|hybrid` (default: `hybrid`)
- Verify contract: `.opentiger/verify.contract.json` (path configurable)
- On LLM planning failure, leaves warning and delegates to Worker auto-strategy

## 6. Startup Constraints

Planner start is blocked when the following backlogs exist:

- local task backlog
- issue task backlog
- PR/judge backlog

This is by design for backlog-first operation.

Exception:

- Planner started with `researchJobId` bypasses normal requirement preflight gating.

## 7. Failure Model

- Inspection runs with retry + quota-aware execution
- Fallback planning attempted even if inspection/task generation fails
- On hard failure, exits without corrupting existing tasks

## 8. Implementation Reference (Source of Truth)

- Startup and overall control: `apps/planner/src/main.ts`, `apps/planner/src/planner-runner.ts`
- Task persistence and plan event: `apps/planner/src/planner-tasks.ts`
- Task policy / allowedPaths adjustment: `apps/planner/src/task-policies.ts`
- Verification command augmentation: `apps/planner/src/planner-verification.ts`
- Issue-based task creation: `apps/planner/src/strategies/from-issue.ts`

## 9. Main Configuration

- `PLANNER_MODEL`
- `PLANNER_TIMEOUT`
- `PLANNER_INSPECT_TIMEOUT`
- `PLANNER_INSPECT_MAX_RETRIES`
- `PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS`
- `PLANNER_DEDUPE_WINDOW_MS`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `PLANNER_VERIFY_COMMAND_MODE`
- `PLANNER_VERIFY_CONTRACT_PATH`
- `PLANNER_VERIFY_MAX_COMMANDS`
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
