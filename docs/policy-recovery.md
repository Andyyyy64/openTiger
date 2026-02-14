# Policy Recovery and AllowedPaths Self-Growth

This document explains how openTiger recovers from policy violations without stopping,  
and how recovery results are reflected into future planning for self-growth.

Related:

- `docs/agent/worker.md`
- `docs/agent/planner.md`
- `docs/flow.md`
- `docs/state-model.md`
- `docs/operations.md`

### Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, When Entering from Policy Violation)

When investigating from policy violation (`needs_rework` chain, etc.), follow: state vocabulary -> transition -> owner -> implementation.

1. `docs/state-model.md` (`needs_rework` / `quota_wait`, etc.)
2. `docs/flow.md` (Worker failure handling and blocked recovery paths)
3. `docs/operations.md` (API procedures and operation shortcuts)
4. `docs/agent/README.md` (owning agent and implementation tracing path)

## 1. Purpose

Even when a task modifies files outside `allowedPaths`, openTiger does not immediately fall into rework chains;  
it first attempts in-run recovery.

Scope note:

- This document covers policy/path recovery (`allowedPaths`, `deniedPaths`).
- Verification command failures (format/order/missing-script) are handled by verification recovery flow in `docs/verification.md`.

Design goals:

- **Self-recovery**: Resolve policy violation within current Worker run
- **Self-growth**: Record successful recovery and reflect it into future Planner `allowedPaths` in advance

## 2. In-Run Self-Recovery (Worker)

Worker verification proceeds in this recovery-priority sequence:

1. Execute `verifyChanges`
2. On policy violation, try deterministic path recovery
   - Extract outside path from violation
   - Generate auto-allow candidates from task context and policy recovery config
   - In `aggressive` mode, violating paths matching `commandDrivenAllowedPathRules[].paths` (e.g. `Makefile`) are also in-run auto-allow candidates
   - Add command-driven paths from shared policy rules
3. Adjust `allowedPaths` and re-verify
4. If violation remains, optionally run LLM recovery (`allow` / `discard` / `deny`)
   - `discard`: discard part of changed files and re-verify
   - `allow`: extend `allowedPaths` and re-verify
   - `deny`: abort recovery and escalate
5. If still unresolved, move task to `blocked(needs_rework)`

### 2.1 LLM Recovery Input

LLM receives:

- Task metadata (`title`, `goal`, `role`, `commands`)
- Current `allowedPaths` and `deniedPaths`
- Violating paths and violation message
- Current changed files
- Summary of queued/running tasks (concurrent execution)

### 2.2 Hard Guardrails

Even when LLM returns `allow`, Worker rejects paths that fail any of:

- Path is safe (no path traversal / absolute path / excessive glob)
- Path is in current violating paths
- Path is not in `deniedPaths` (`deniedPaths` always wins)

### 2.3 Mode-Specific Deterministic Behavior

Deterministic auto-allow scope varies by mode:

- `conservative`
  - Context-file match only
  - No infra-file extension
- `balanced`
  - Context-file match + infra-file extension
  - No root-level / command-driven violation auto-allow
- `aggressive` (default)
  - `balanced` plus:
    - Root-level infra path recovery
    - Command-driven rule path recovery (e.g. `Makefile` for make rules)

### 2.4 Generated Artifact Path Auto-Learning

When violation remains after LLM recovery, Worker attempts final recovery by discarding likely-generated paths:

1. Extract violating paths via `isLikelyGeneratedArtifactPath()`
   - e.g. `.dump`, `.log`, `.tmp`, `.trace`
   - Path segments like `coverage`, `report`, `artifact`, `build`, `dist`
2. Discard extracted files and re-verify
3. Save learning to `.opentiger/generated-paths.auto.txt`; treat as generated in future `verifyChanges`

No manual editing of `generated-paths.txt` needed.  
`GENERATED_PATHS` / `WORKER_EXTRA_GENERATED_PATHS` / `.opentiger/generated-paths.auto.txt` are merged for verification.

### 2.5 Docser Constraints

Docser has intentional constraints:

- Deterministic policy auto-allow does not add paths
- Does not run LLM policy recovery
- Verification commands limited to doc-safe check-style (e.g. `pnpm run check`)

## 3. Shared Policy Recovery Engine (Core)

Shared logic lives in `packages/core/src/policy-recovery.ts`, reused by Worker/Cycle Manager/Planner.

Main responsibilities:

- Load and merge config
  - Built-in default
  - `.opentiger/policy-recovery.json`
  - Env override
- Resolve command-driven paths
- Extract violation paths
- Resolve mode-specific deterministic auto-allow candidates
  - `conservative`
  - `balanced`
  - `aggressive` (default)

## 4. Verification Command Format Recovery

When verification command fails due to unsupported format (shell operator / `$()`),
missing script, or command-sequence issue,
Cycle Manager adjusts the command and requeues instead of infinite block.

- `requeue-failed`:
  - `verification_command_unsupported_format` / `verification_command_missing_script`
    - Remove failed command from `commands` and requeue
  - `verification_command_sequence_issue`
    - Reorder clean-like command and generated-artifact check (`test -f/-s ...`) to avoid invalid order
  - `policy_violation`
    - Try allowed path adjustment and requeue

Worker may skip explicit command failure within the same run when remaining commands exist or earlier steps already passed (e.g. doc-only/no-op).

## 5. Rework Chain Suppression (Cycle Manager)

Cycle Manager suppresses policy-only failure and rework chain amplification.

- `requeue-failed`:
  - For `policy_violation`, try allowed path adjustment + requeue
- `requeue-blocked`:
  - When blocked task has outside-allowed violation:
    - Requeue same task if safe path can be added
    - Otherwise suppress retry up to `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`, then cancel
    - Emit `policy_violation_rework_suppressed_no_safe_path` or `policy_violation_rework_suppressed_exhausted`
  - Do not create rework split when valid rework child (active) already exists for same parent
  - Cancel when `[auto-rework] parentTask=` depth is `AUTO_REWORK_MAX_DEPTH` or more

This prevents unbounded growth of `[Rework] ...` children.

## 6. Planner Self-Growth

Planner uses past recovery results to extend future task `allowedPaths` in advance.

Flow:

1. Read recent `task.policy_recovery_applied` events
2. Aggregate hints by role/path frequency
3. Inject hints into requirement note and pass to planning context
4. Reflect matched hints directly into generated task `allowedPaths`

Representative hint reasons:

- `context_file_match`
- `signal_match_strong`
- `signal_match_repeated_weak`

Planner also records path addition reasons:

- `planner.plan_created.payload.policyRecoveryHintApplications`
  - Per-task added paths
  - Matched hint metadata (role, count, reason, source text)

## 7. Configuration

### 7.1 Repository Config File

Default file:

- `.opentiger/policy-recovery.json`

Template:

- `templates/policy-recovery.example.json`

Main keys:

- `mode`
- `replaceDefaultCommandDrivenAllowedPathRules`
- `commandDrivenAllowedPathRules`
- `infraSignalTokens`
- `safeInfraFileBasenames`
- `safeInfraFileExtensions`
- `safeHiddenRootFiles`

### 7.2 Environment Variables

Core:

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE`

Worker recovery:

- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`

Cycle Manager rework suppression:

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES` (default: 2)
  - Max suppression retries when no safe path found
- `AUTO_REWORK_MAX_DEPTH` (default: 2)
  - Max rework chain depth; cancel when exceeded

Worker verification skip:

- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT` (default: `true`)
  - Skip missing/unsupported explicit command when remaining commands exist

## 8. Event Reference

Recovery observation events:

- `task.policy_recovery_decided`
  - LLM decision summary and raw decision group
- `task.policy_recovery_applied`
  - Applied action (`allow` / `discard` / `allow+discard`) and result paths
- `task.policy_recovery_denied`
  - Details of denied decision

Related queue recovery events:

- `task.requeued` (reason)
  - `policy_allowed_paths_adjusted`
  - `policy_allowed_paths_adjusted_from_blocked`
  - `verification_command_missing_script_adjusted`
  - `verification_command_unsupported_format_adjusted`
  - `verification_command_sequence_adjusted`
  - `cooldown_retry`
- `task.recovery_escalated` (reason)
  - `policy_violation_rework_suppressed_no_safe_path`
  - `policy_violation_rework_suppressed_exhausted`
  - `rework_child_already_exists`
  - `rework_chain_max_depth_reached`

Planner observation:

- `planner.plan_created.payload.policyRecoveryHintApplications`

## 9. Operation Notes

- This mechanism uses existing events/tasks data; no schema migration needed
- For stricter behavior, switch to `balanced` or `conservative`
- Adjust Worker timeout/model for faster recovery decisions
- For decision quality, increase attempts carefully and monitor queue delay
