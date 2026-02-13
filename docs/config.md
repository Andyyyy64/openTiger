# System Configuration Guide

This document covers runtime settings managed by `system_config` and `/system` APIs.

## 1. Where Settings Live

- Persistent config store:
  - DB table `config` (served by `/config` API)
- Process control and orchestration:
  - `/system` API routes
- Environment-only controls:
  - startup env vars for services (not all are in `config` table)

## 2. Recommended Setup Order (Top Priority First)

Configure these first:

1. Git and repository settings
2. LLM provider API keys
3. Model selection
4. Agent/process counts
5. Recovery and quota behavior
6. Replan behavior

## 3. Core `system_config` Keys

### 3.1 Git / Repo

- `REPO_MODE` (`git` or `local`)
- `REPO_URL`
- `BASE_BRANCH`
- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `GITHUB_AUTH_MODE` (`gh` or `token`, default: `gh`)
- `GITHUB_TOKEN` (required only when `GITHUB_AUTH_MODE=token`)
- `GITHUB_OWNER`
- `GITHUB_REPO`

### 3.2 LLM Provider Keys

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`
- `DEEPSEEK_API_KEY`

### 3.3 Model Selection

- `LLM_EXECUTOR` (`opencode` / `claude_code`)
- `OPENCODE_MODEL`
- `OPENCODE_SMALL_MODEL`
- `PLANNER_MODEL`
- `JUDGE_MODEL`
- `WORKER_MODEL`
- `TESTER_MODEL`
- `DOCSER_MODEL`
- `CLAUDE_CODE_MODEL`

### 3.4 Agent Scaling and Switches

- `EXECUTION_ENVIRONMENT` (`host` or `sandbox`)
- `DISPATCHER_ENABLED`
- `JUDGE_ENABLED`
- `CYCLE_MANAGER_ENABLED`
- `WORKER_COUNT`
- `TESTER_COUNT`
- `DOCSER_COUNT`
- `JUDGE_COUNT`
- `PLANNER_COUNT`

Notes:

- `EXECUTION_ENVIRONMENT=host` uses host process launch (`LAUNCH_MODE=process`).
- `EXECUTION_ENVIRONMENT=sandbox` uses docker launch (`LAUNCH_MODE=docker`).
- Detailed sandbox operation and Claude authentication notes are in `docs/execution-mode.md`.
- Planner is operationally capped to one process in system start logic.
- Worker/tester/docser/judge can be scaled by count.

### 3.5 Quota and Replan

- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`
- `AUTO_REPLAN`
- `REPLAN_REQUIREMENT_PATH`
- `REPLAN_INTERVAL_MS`
- `REPLAN_COMMAND`
- `REPLAN_WORKDIR`
- `REPLAN_REPO_URL`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`

### 3.6 Policy Recovery and AllowedPaths Growth

Core policy recovery config:

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE` (`conservative` / `balanced` / `aggressive`)

Worker in-run policy recovery:

- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`

Repo-level config file:

- default path: `.opentiger/policy-recovery.json`
- example: `templates/policy-recovery.example.json`

Cycle Manager rework suppression (env):

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES` (default: 2)
- `AUTO_REWORK_MAX_DEPTH` (default: 2)

Verification command skip (Worker env):

- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT` (default: `true`)

Operational detail:

- full recovery/growth lifecycle is documented in `docs/policy-recovery.md`

### 3.7 Prompt Context Snapshot and Delta

openTiger keeps runtime prompt context in local files under `.opentiger/context/`:

- `.opentiger/context/agent-profile.json`
  - host snapshot generated from `neofetch`
  - `uname -srmo` is used as a fallback for minimal host/kernel/arch context
  - refreshed by TTL/fingerprint checks
- `.opentiger/context/context-delta.json`
  - failure signatures and promoted context keys
  - updated on execution/verification failures for next-task hints

Notes:

- These JSON files are local runtime artifacts and are intentionally git-ignored.
- Prompt context is injected in compact form with a fixed character budget:
  - Host context: `550`
  - Failure hints: `350`
  - Total: `900`

## 4. `/config` API (Backed by DB)

- `GET /config`
  - returns current config snapshot
- `PATCH /config`
  - updates selected keys via `{ updates: Record<string, string> }`

Behavior:

- unknown keys are rejected
- missing keys retain previous values
- config is persisted and reflected in UI `system_config`

## 5. `/system` API (Runtime Orchestration)

### 5.1 Startup Planning

- `POST /system/preflight`
  - builds launch recommendation from requirement content + issue/PR/task backlog
  - may skip planner intentionally when issue/pr backlog exists

Issue role assignment (required for automatic issue -> task import):

- open issue must explicitly declare agent role
- accepted label format:
  - `role:worker`
  - `role:tester`
  - `role:docser`
- accepted body format:
  - `Agent: worker` (or `tester`, `docser`)
  - `Role: worker` (or `tester`, `docser`)
  - markdown section:
    - `## Agent`
    - `- worker` (or `tester`, `docser`)

If explicit role is missing:

- preflight does not auto-create a task from that issue
- warning is reported in preflight summary

### 5.2 Process Control

- `GET /system/processes`
- `GET /system/processes/:name`
- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

Important runtime behavior:

- planner duplicate start is blocked
- live bound agent detection can return already-running without launching duplicate process
- Judge backlog (`openPrCount > 0` or `pendingJudgeTaskCount > 0`) arms runtime hatch and auto-starts Judge process when down (self-heal tick)

### 5.3 Requirement / Repo Utilities

- `GET /system/requirements`
- `POST /system/github/repo`
- `GET /system/host/neofetch`
  - returns normalized host info source output for dashboard display
- `GET /system/host/context`
  - returns current host snapshot payload and refresh status

### 5.4 Maintenance

- `POST /system/cleanup`

Warning:

- `/system/cleanup` truncates runtime tables and clears queue state.
- process restart control is managed by `SYSTEM_PROCESS_AUTO_RESTART*` environment variables.

## 6. Process Names You Can Start/Stop

Static names:

- `planner`
- `dispatcher`
- `cycle-manager`
- `db-up`
- `db-down`
- `db-push`

Dynamic names:

- `judge`, `judge-2`, `judge-3`, ...
- `worker-1`, `worker-2`, ...
- `tester-1`, `tester-2`, ...
- `docser-1`, `docser-2`, ...

## 7. Operational Policy Alignment

This project policy is:

- do not stall
- no fixed-minute watchdog as primary trigger
- force recovery strategy switching based on runtime events

Examples:

- repeated failures -> `needs_rework` path
- quota failure -> `quota_wait` path
- judge backlog inconsistencies -> run restoration / requeue path

## 8. Minimal Production Baseline

- set `GITHUB_AUTH_MODE` and valid `GITHUB_OWNER`/`GITHUB_REPO`
- if `GITHUB_AUTH_MODE=token`, set valid `GITHUB_TOKEN`
- set at least one working LLM API key and model
- keep `PLANNER_COUNT=1`
- set `WORKER_COUNT>=1`, `JUDGE_COUNT>=1`
- keep `DISPATCHER_ENABLED=true`, `JUDGE_ENABLED=true`, `CYCLE_MANAGER_ENABLED=true`
