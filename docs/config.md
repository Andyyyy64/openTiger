# System Configuration Guide

This document organizes openTiger configuration into "DB-managed config" and "env-only config."  
Primary sources are:

- DB-managed keys: `apps/api/src/system-config.ts` (`CONFIG_FIELDS`)
- Env-only config: each runtime (dispatcher/worker/judge/cycle-manager/api)

### Common Lookup Path (state vocabulary -> transition -> owner -> implementation, when entering from config change)

If stalls occur after config changes, check in order: state vocabulary -> transition -> owner -> implementation.

1. [state-model](state-model.md) (state vocabulary)
2. [flow](flow.md) (transitions and recovery paths)
3. [operations](operations.md) (API procedures and operation shortcuts)
4. [agent/README](agent/README.md) (owning agent and implementation tracing path)

## 1. Config Storage

### Database-Managed (`config` table)

- Read/update via `/config` API
- Update from Dashboard system settings
- Can sync to `.env` via `scripts/export-config-to-env.ts`

### Env-Only Configuration

- Read only at process startup
- Not stored in `config` table

---

## 2. DB-Managed Key List (`CONFIG_FIELDS`)

### 2.1 Limits

- `MAX_CONCURRENT_WORKERS`
- `DAILY_TOKEN_LIMIT`
- `HOURLY_TOKEN_LIMIT`
- `TASK_TOKEN_LIMIT`

### 2.2 Process Enablement / Scaling

- `DISPATCHER_ENABLED`
- `JUDGE_ENABLED`
- `CYCLE_MANAGER_ENABLED`
- `EXECUTION_ENVIRONMENT` (`host` or `sandbox`)
- `WORKER_COUNT`
- `TESTER_COUNT`
- `DOCSER_COUNT`
- `JUDGE_COUNT`
- `PLANNER_COUNT`

Note:

- Planner runs as a single process (duplicate-start guard)

### 2.3 Repository / GitHub

- `REPO_MODE` (`git` or `local`)
- `REPO_URL`
- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`
- `GITHUB_AUTH_MODE` (`gh` or `token`)
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

### 2.4 Executor / Model

- `LLM_EXECUTOR` (`opencode` / `claude_code` / `codex`)
- `WORKER_LLM_EXECUTOR` (`inherit` / `opencode` / `claude_code` / `codex`)
- `TESTER_LLM_EXECUTOR` (`inherit` / `opencode` / `claude_code` / `codex`)
- `DOCSER_LLM_EXECUTOR` (`inherit` / `opencode` / `claude_code` / `codex`)
- `JUDGE_LLM_EXECUTOR` (`inherit` / `opencode` / `claude_code` / `codex`)
- `PLANNER_LLM_EXECUTOR` (`inherit` / `opencode` / `claude_code` / `codex`)
- `OPENCODE_MODEL`
- `OPENCODE_SMALL_MODEL`
- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`
- `CODEX_MODEL`
- `CODEX_MAX_RETRIES`
- `CODEX_RETRY_DELAY_MS`
- `CLAUDE_CODE_PERMISSION_MODE`
- `CLAUDE_CODE_MODEL`
- `CLAUDE_CODE_MAX_TURNS`
- `CLAUDE_CODE_ALLOWED_TOOLS`
- `CLAUDE_CODE_DISALLOWED_TOOLS`
- `CLAUDE_CODE_APPEND_SYSTEM_PROMPT`
- `PLANNER_MODEL`
- `JUDGE_MODEL`
- `WORKER_MODEL`
- `TESTER_MODEL`
- `DOCSER_MODEL`

Executor resolution notes:

- `LLM_EXECUTOR` default is `claude_code`.
- Role-specific `*_LLM_EXECUTOR` supports `inherit` to follow `LLM_EXECUTOR`.
- If `LLM_EXECUTOR` is missing or unrecognized at runtime, it falls back to `claude_code`.

### 2.5 Planner / Replan

- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `AUTO_REPLAN`
- `REPLAN_REQUIREMENT_PATH`
- `REPLAN_INTERVAL_MS`
- `REPLAN_COMMAND`
- `REPLAN_WORKDIR`
- `REPLAN_REPO_URL`

Resolution note:

- When `REPLAN_REQUIREMENT_PATH` is relative (for example `docs/requirement.md`) and the file is not found under `REPLAN_WORKDIR`, Cycle Manager also resolves it against the managed git repository cache (`~/.opentiger/repos/<owner>/<repo>`), derived from `REPO_URL` / `REPLAN_REPO_URL`.

### 2.6 LLM Provider Keys

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `XAI_API_KEY`
- `DEEPSEEK_API_KEY`

### 2.7 Main Defaults (Initial State)

- `EXECUTION_ENVIRONMENT=host`
- `LLM_EXECUTOR=claude_code`
- `WORKER_LLM_EXECUTOR=inherit`
- `TESTER_LLM_EXECUTOR=inherit`
- `DOCSER_LLM_EXECUTOR=inherit`
- `JUDGE_LLM_EXECUTOR=inherit`
- `PLANNER_LLM_EXECUTOR=inherit`
- `CODEX_MODEL=gpt-5.3-codex`
- `BASE_BRANCH=main`
- `REPO_MODE=git`
- `WORKER_COUNT=4`
- `TESTER_COUNT=4`
- `DOCSER_COUNT=4`
- `JUDGE_COUNT=4`
- `PLANNER_COUNT=1`
- `AUTO_REPLAN=true`
- `REPLAN_REQUIREMENT_PATH=docs/requirement.md`
- `REPLAN_INTERVAL_MS=60000`
- `GITHUB_AUTH_MODE=gh`
- `MAX_CONCURRENT_WORKERS=-1` (unlimited)
- `DAILY_TOKEN_LIMIT=-1` (unlimited)
- `HOURLY_TOKEN_LIMIT=-1` (unlimited)
- `TASK_TOKEN_LIMIT=-1` (unlimited)

---

## 3. `/config` API

- `GET /config`
  - Current config snapshot
- `PATCH /config`
  - body: `{ updates: Record<string, string> }`

Behavior:

- Unknown keys rejected
- Unspecified keys retained
- When `AUTO_REPLAN=true`, `REPLAN_REQUIREMENT_PATH` is required

---

## 4. `/system` API and Config Interaction

### 4.1 Preflight

- `POST /system/preflight`
- Returns recommended startup configuration from requirement content + local backlog + GitHub backlog

Issue auto-task requires explicit role:

- label: `role:worker|role:tester|role:docser`
- body: `Agent: ...` / `Role: ...` / `## Agent` section

### 4.2 Process Manager

- `GET /system/processes`
- `GET /system/processes/:name`
- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

### 4.3 Requirement / Repository APIs

- `GET /system/requirements`
- `POST /system/requirements`
- `POST /system/github/repo`
- `GET /system/github/repos`
- `GET /system/github/auth`
- `GET /system/claude/auth`
- `GET /system/codex/auth`
- `GET /system/host/neofetch`
- `GET /system/host/context`

### 4.4 Maintenance

- `POST /system/cleanup`

Warning:

- Destructive operation that initializes runtime tables and queue

---

## 5. Requirement Sync Behavior

`POST /system/requirements` performs:

1. Save input to requirement file
2. Sync to canonical path `docs/requirement.md`
3. For git repositories, attempt snapshot commit/push

Thus requirement edits affect both "file save" and "repository state update."

### 5.1 Startup Auto-Completion (config-store)

`ensureConfigRow()` performs the following on startup:

- Self-repair of required columns (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
- Auto-completion from workspace/git info
  - `repoUrl`, `githubOwner`, `githubRepo`, `baseBranch`
  - requirement path candidates (e.g. `docs/requirement.md`)
- Legacy value normalization
  - Unify old `REPLAN_COMMAND` to `pnpm --filter @openTiger/planner run start:fresh`
  - Unify old token/concurrency fixed values to `-1` unlimited

---

## 6. Env-Only Main Config

Representative examples controlled only by env (not DB):

### 6.1 Process Restart / Self-Heal

- `SYSTEM_PROCESS_AUTO_RESTART`
- `SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS`
- `SYSTEM_PROCESS_SELF_HEAL`
- `SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS`
- `SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS`
- `SYSTEM_AGENT_LIVENESS_WINDOW_MS`
- `OPENTIGER_PRESERVE_MANAGED_ON_DEV_SIGTERM`
  - Default behavior preserves managed processes on API `dev` hot-restart (`SIGTERM`)
  - Set `false` to restore strict shutdown of managed processes on API SIGTERM

### 6.2 Task Retry / Cooldown

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD`
- `DISPATCH_RETRY_DELAY_MS`
- `STUCK_RUN_TIMEOUT_MS`
- `DISPATCH_MAX_POLL_INTERVAL_MS`
- `DISPATCH_NO_IDLE_LOG_INTERVAL_MS`

Notes:

- `FAILED_TASK_MAX_RETRY_COUNT=-1` keeps category-level retry limits.
- `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD` controls when repeated identical failure signatures are escalated
  (default: `4`).
- Failure classification is structured-first (`runs.error_meta.failureCode`) with legacy message fallback.

### 6.3 Policy Recovery

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`
- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`
- `AUTO_REWORK_MAX_DEPTH`

### 6.4 Verification Command Planning

Planner:

- `PLANNER_VERIFY_COMMAND_MODE`
- `PLANNER_VERIFY_CONTRACT_PATH`
- `PLANNER_VERIFY_MAX_COMMANDS`
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `PLANNER_VERIFY_AUGMENT_NONEMPTY`

Worker:

- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_AUTO_VERIFY_MAX_COMMANDS`
- `WORKER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `WORKER_VERIFY_PLAN_PARSE_RETRIES`
- `WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT`
- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT`
- `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS`
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY`
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY_CANDIDATES`

### 6.5 Dispatcher / Lease / Agent Liveness

- `POLL_INTERVAL_MS`
- `DISPATCH_BLOCK_ON_AWAITING_JUDGE`
- `DISPATCH_AGENT_HEARTBEAT_TIMEOUT_SECONDS`
- `DISPATCH_AGENT_RUNNING_RUN_GRACE_MS`
- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

### 6.6 Cycle Manager Loop / Anomaly / Replan

- `MONITOR_INTERVAL_MS`
- `CLEANUP_INTERVAL_MS`
- `STATS_INTERVAL_MS`
- `AUTO_START_CYCLE`
- `SYSTEM_API_BASE_URL`
- `ISSUE_SYNC_INTERVAL_MS`
- `ISSUE_SYNC_TIMEOUT_MS`
- `CYCLE_MAX_DURATION_MS`
- `CYCLE_MAX_TASKS`
- `CYCLE_MAX_FAILURE_RATE`
- `CYCLE_CRITICAL_ANOMALY_RESTART_COOLDOWN_MS`
- `CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS`
- `ANOMALY_REPEAT_COOLDOWN_MS`
- `REPLAN_PLANNER_ACTIVE_WINDOW_MS`
- `REPLAN_SKIP_SAME_SIGNATURE`

### 6.7 Sandbox Execution

- `SANDBOX_DOCKER_IMAGE`
- `SANDBOX_DOCKER_NETWORK`
- `CLAUDE_AUTH_DIR`
- `CLAUDE_CONFIG_DIR`

### 6.8 Logging

- `OPENTIGER_LOG_DIR` (optional)
- `OPENTIGER_RAW_LOG_DIR` (legacy fallback)

Notes:

- If both are unset, runtime uses `<repo-root>/raw-logs`.
- Legacy placeholder values such as `/absolute/path/to/openTiger/raw-logs` are ignored and fallback is used.

### 6.9 TigerResearch

Runtime enablement and planner handoff:

- `RESEARCH_ENABLED`
- `RESEARCH_PLANNER_PENDING_WINDOW_MS`
- `RESEARCH_REQUIRE_JUDGE`

Cycle-orchestrator quality thresholds:

- `RESEARCH_MAX_CONCURRENCY`
- `RESEARCH_MAX_DEPTH`
- `RESEARCH_MIN_EVIDENCE_PER_CLAIM`
- `RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM`
- `RESEARCH_REQUIRE_COUNTER_EVIDENCE`
- `RESEARCH_MIN_REPORT_CONFIDENCE`
- `RESEARCH_MIN_VERIFIABLE_RATIO`

Judge research thresholds:

- `JUDGE_RESEARCH_MIN_CLAIMS`
- `JUDGE_RESEARCH_MIN_EVIDENCE_PER_CLAIM`
- `JUDGE_RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM`
- `JUDGE_RESEARCH_REQUIRE_COUNTER_EVIDENCE`
- `JUDGE_RESEARCH_MIN_CONFIDENCE`
- `JUDGE_RESEARCH_MIN_VERIFIABLE_RATIO`

---

## 7. Authentication / Access Control Notes

- System control uses `api-key` / `bearer`
- In local development, `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL` changes behavior
  - Set to `false` for strict operation
- When using GitHub CLI mode (`gh`), ensure `gh auth login` is done

---

## 8. Minimum Operation Set

1. Repo config (`REPO_MODE`, `REPO_URL` or local path)
2. GitHub config (`GITHUB_AUTH_MODE`, owner/repo, token if needed)
3. LLM config (`LLM_EXECUTOR`, `*_LLM_EXECUTOR`, model, provider key)
4. Counts (`WORKER_COUNT`, `JUDGE_COUNT`, `PLANNER_COUNT=1`)
5. Recovery config (retry / cooldown / auto restart)

See [operations](operations.md) for more detailed operation.

---

## 9. Config Change Impact Map (Operation Reference)

Config impact depends on which processes read it.  
Env-only config is not reflected until the target process restarts.

| Config category   | Main keys                                                                                                                                                         | Affected components                                      | When reflected                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| Repository/GitHub | `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`, `GITHUB_*`                                                                                                                | API preflight, Planner, Dispatcher, Worker, Judge        | After target process restart              |
| Execution/launch  | `EXECUTION_ENVIRONMENT`, `SANDBOX_DOCKER_*`                                                                                                                       | API process manager, Dispatcher launcher, sandbox worker | After Dispatcher restart (from new tasks) |
| Planner           | `PLANNER_*`, `PLANNER_LLM_EXECUTOR`, `LLM_EXECUTOR`, `AUTO_REPLAN`, `REPLAN_*`                                                                                    | Planner, Cycle Manager                                   | After Planner / Cycle Manager restart     |
| Dispatcher        | `MAX_CONCURRENT_WORKERS`, `POLL_INTERVAL_MS`, `DISPATCH_*`                                                                                                        | Dispatcher                                               | After Dispatcher restart                  |
| Worker execution  | `WORKER_*`, `TESTER_*`, `DOCSER_*`, `WORKER_LLM_EXECUTOR`, `TESTER_LLM_EXECUTOR`, `DOCSER_LLM_EXECUTOR`, `LLM_EXECUTOR`, `CLAUDE_CODE_*`, `CODEX_*`, `OPENCODE_*` | Worker/Tester/Docser                                     | After target agent restart                |
| Judge             | `JUDGE_*`, `JUDGE_LLM_EXECUTOR`, `LLM_EXECUTOR`, `JUDGE_MODE`                                                                                                     | Judge                                                    | After Judge restart                       |
| Retry/cleanup     | `FAILED_TASK_*`, `BLOCKED_TASK_*`, `STUCK_RUN_TIMEOUT_MS`                                                                                                         | Cycle Manager, API task retry display                    | After Cycle Manager / API restart         |

### Notes

- Updating DB-managed keys does not auto-update env for already-running processes.
- Restarting only affected processes via start/stop is safer than full stop-all.
- See [operations](operations.md#10-safe-restart-procedure-for-config-changes) for specific steps.
