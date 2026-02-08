# Planner Agent

## 1. Role

Split requirements into executable tasks and save them to `tasks`.

Notes:

- If Start preflight detects an issue backlog, Planner is not started with priority
- In that case, issue-derived tasks run first

## 2. Inputs

- Requirement file
- Existing task state
- Policy / allowed paths

Primary conditions for Planner to start after preflight:

- Requirement text exists
- There is no open issue backlog

## 3. Outputs

- Task creation
- Dependencies
- Priority
- Risk level

## 4. Key Specifications

- Tasks must have machine-judgable goals
- Fix circular or forward dependencies
- Auto-inject initialization tasks for uninitialized repos
- Use a dedupe window to avoid duplicate plans

## 5. Main Settings

- `PLANNER_MODEL`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `PLANNER_TIMEOUT`
- `PLANNER_INSPECT`
- `PLANNER_INSPECT_TIMEOUT`
- `PLANNER_DEDUPE_WINDOW_MS`

## 6. On Failure

- Record errors when requirement parsing fails
- Sanitize and save invalid outputs
- On critical failure, exit without breaking existing tasks

## 7. Operational Notes

- Planner prioritizes "non-stalling splits" over optimization
- Prefer small, re-runnable plans over tightly coupled dependencies
