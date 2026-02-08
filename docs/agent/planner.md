# Planner Agent

## 1. Role

Generate executable tasks from requirement input and persist them safely.

Planner is intentionally single-instance in system control to avoid duplicate planning races.

## 2. Inputs

- requirement file/content
- existing task backlog hints
- judge feedback summaries
- repository snapshot + inspection output

## 3. Planning Pipeline

1. Parse and validate requirement
2. Load judge feedback and existing-task hints
3. Run codebase inspection (LLM)
4. Generate tasks (LLM/simple fallback path)
5. Normalize dependencies and allowed paths
6. Attach policy fields (role, commands, notes)
7. Save tasks with dedupe signature lock
8. Optionally create linked GitHub issues

## 4. Key Behaviors

- initialization task auto-injection for uninitialized repos
- dependency index sanitization and redundancy reduction
- lockfile path allowance normalization
- doc gap detection and optional docser task injection
- plan save dedupe using advisory lock + event signature

## 5. Start Constraints

Planner may be skipped by preflight if backlog exists.

Planner start is blocked when PR/judge backlog exists in `/system/processes/:name/start` checks.

## 6. Failure Model

- inspection has retry and quota-aware delay logic
- if inspection cannot produce usable output, planning aborts for that run
- existing tasks remain untouched

## 7. Important Settings

- `PLANNER_MODEL`
- `PLANNER_TIMEOUT`
- `PLANNER_INSPECT_TIMEOUT`
- `PLANNER_INSPECT_MAX_RETRIES`
- `PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS`
- `PLANNER_DEDUPE_WINDOW_MS`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
