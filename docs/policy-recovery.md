# Policy Recovery and AllowedPaths Growth

This document explains how openTiger handles policy violations without stalling, and how recovery outcomes are fed back into future planning.

## 1. Purpose

When a task modifies a file outside `allowedPaths`, openTiger tries to recover in the same run first, instead of immediately creating endless rework chains.

The design has two goals:

- **Self-recovery**: resolve policy violations inside the current Worker run when possible.
- **Self-growth**: persist useful recovery outcomes and proactively expand future `allowedPaths` in Planner.

## 2. In-Run Self-Recovery (Worker)

Worker verification uses a recovery-first sequence:

1. Run `verifyChanges`.
2. If policy violations exist, try deterministic path recovery:
   - extract outside paths from violations
   - derive auto-allow candidates from task context and policy recovery config
   - in `aggressive` mode, if a violating path is listed in `commandDrivenAllowedPathRules[].paths` (for example `Makefile`), treat it as an in-run auto-allow candidate
   - add command-driven paths from shared policy rules
3. Re-run verification with adjusted `allowedPaths`.
4. If violations remain, run optional LLM recovery (`allow` / `discard` / `deny`):
   - `discard`: remove selected changed files and re-verify
   - `allow`: extend `allowedPaths` and re-verify
   - `deny`: stop recovery attempts and escalate
5. If still unresolved, mark task as `blocked(needs_rework)`.

### 2.1 LLM Recovery Input

LLM receives contextual data, including:

- task metadata (`title`, `goal`, `role`, `commands`)
- current `allowedPaths` and `deniedPaths`
- violating paths and policy violation messages
- current changed files
- summaries of concurrent queued/running tasks

### 2.2 Hard Guardrails

Even when LLM suggests `allow`, Worker blocks unsafe decisions:

- path must be safe (no traversal, no absolute path, no glob abuse)
- path must be one of current violating paths
- `deniedPaths` always win over `allow`

### 2.3 Mode-Specific Deterministic Behavior

Deterministic auto-allow differs by policy mode:

- `conservative`
  - context-file matches only
  - no infra-file expansion
- `balanced`
  - context-file matches + infra-file expansion
  - no aggressive root-level/command-driven violation auto-allow
- `aggressive` (default)
  - balanced behavior, plus:
    - root-level infra path recovery
    - command-driven rule path recovery from violating paths (e.g., `Makefile` when make-related rule is configured)

### 2.4 Generated Artifact Path Auto-Learning

When policy violations remain after LLM recovery, Worker attempts a final recovery by treating likely-generated artifacts (e.g., `kernel.dump`, `*.log`, build outputs) as safe to discard:

1. Filter violating paths with `isLikelyGeneratedArtifactPath()` (extensions: `.dump`, `.log`, `.tmp`, `.trace`; path segments: `coverage`, `report`, `artifact`, `build`, `dist`, etc.).
2. Discard those files and re-run verification.
3. Persist learned paths to `.opentiger/generated-paths.auto.txt` so future runs treat them as generated from the first `verifyChanges` call.

No manual edits to `generated-paths.txt` are required; learning happens at runtime. The built-in `GENERATED_PATHS`, `WORKER_EXTRA_GENERATED_PATHS`, and `.opentiger/generated-paths.auto.txt` are merged for each verification cycle.

### 2.5 Docser Behavior

`docser` is intentionally restricted:

- deterministic policy auto-allow logic returns no extra paths for `docser`
- Worker skips LLM policy recovery for `docser`
- `docser` verification commands are filtered to doc-safe `check` commands (e.g., `pnpm run check`)

## 3. Shared Policy Recovery Engine (Core)

Shared logic lives in `packages/core/src/policy-recovery.ts` and is reused by Worker, Cycle Manager, and Planner.

Main responsibilities:

- config loading and merge:
  - built-in defaults
  - `.opentiger/policy-recovery.json`
  - env overrides
- command-driven path resolution
- policy violation path extraction
- deterministic auto-allow candidate resolution by mode:
  - `conservative`
  - `balanced`
  - `aggressive` (default)

## 4. Verification Command Format Recovery

When verification commands fail due to unsupported format (shell operators, `$()` command substitution) or missing script, Cycle Manager adjusts commands and requeues instead of blocking indefinitely:

- `requeue-failed`:
  - for `verification_command_unsupported_format` or `verification_command_missing_script`:
    - remove the failed command from `commands` and requeue
  - for `policy_violation`, tries allowed path adjustment and requeue

Worker also skips such explicit command failures within the same run when remaining commands exist, or when prior commands passed (e.g., doc-only / no-op changes).

## 5. Rework Chain Suppression (Cycle Manager)

Cycle Manager prevents policy-only and rework-chain amplification:

- `requeue-failed`:
  - for `policy_violation`, tries allowed path adjustment and requeue
- `requeue-blocked`:
  - if blocked task has outside-allowed violations:
    - requeue same task when safe paths can be added
    - otherwise: retry suppression up to `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`, then cancel
    - emit `policy_violation_rework_suppressed_no_safe_path` or `policy_violation_rework_suppressed_exhausted`
  - rework split: skip if active rework child already exists for same parent
  - rework depth: cancel if `[auto-rework] parentTask=` count >= `AUTO_REWORK_MAX_DEPTH`

This avoids repeatedly spawning `[Rework] ...` children and runaway rework chains.

## 6. Self-Growth in Planner

Planner uses past recovery outcomes to proactively expand future `allowedPaths`.

Flow:

1. Load recent `task.policy_recovery_applied` events.
2. Aggregate path hints by role/path frequency.
3. Inject hints into requirement notes for planning context.
4. Apply matched hints directly to generated tasks' `allowedPaths`.

Hint match reasons:

- `context_file_match`
- `signal_match_strong`
- `signal_match_repeated_weak`

Planner also records why paths were added:

- `planner.plan_created.payload.policyRecoveryHintApplications`
  - task-level added paths
  - matched hint metadata (role, count, reason, source text)

## 7. Configuration

### 7.1 Repo Config File

Default file:

- `.opentiger/policy-recovery.json`

Example template:

- `templates/policy-recovery.example.json`

Supported keys:

- `mode`
- `replaceDefaultCommandDrivenAllowedPathRules`
- `commandDrivenAllowedPathRules`
- `infraSignalTokens`
- `safeInfraFileBasenames`
- `safeInfraFileExtensions`
- `safeHiddenRootFiles`

### 7.2 Environment Variables

Core config:

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE`

Worker recovery:

- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`

Cycle Manager rework suppression:

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES` (default: 2) — max retries when no safe policy path exists
- `AUTO_REWORK_MAX_DEPTH` (default: 2) — max rework chain depth before cancellation

Verification command skip (Worker):

- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT` (default: `true`) — skip missing/unsupported explicit commands when remaining commands exist

## 8. Event Reference

Recovery observability events:

- `task.policy_recovery_decided`
  - LLM decision summary and raw decision groups
- `task.policy_recovery_applied`
  - applied action (`allow`, `discard`, `allow+discard`) and resulting paths
- `task.policy_recovery_denied`
  - denied decision details

Related queue recovery events:

- `task.requeued` with reasons:
  - `policy_allowed_paths_adjusted`
  - `policy_allowed_paths_adjusted_from_blocked`
  - `verification_command_missing_script_adjusted`
  - `verification_command_unsupported_format_adjusted`
  - `cooldown_retry`
- `task.recovery_escalated` with reason:
  - `policy_violation_rework_suppressed_no_safe_path`
  - `policy_violation_rework_suppressed_exhausted`
  - `rework_child_already_exists`
  - `rework_chain_max_depth_reached`

Planner observability:

- `planner.plan_created.payload.policyRecoveryHintApplications`

## 9. Operational Notes

- This mechanism uses existing events/tasks data; no schema migration is required.
- If you need stricter behavior, switch mode to `balanced` or `conservative`.
- If you need faster recovery decisions, tune timeout/model via Worker env vars.
- If analysis quality matters more than speed, increase attempts carefully and watch queue latency.
