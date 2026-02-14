# Verification Command Strategy

openTiger handles verification commands in both Planner and Worker.  
This document summarizes the implementation spec for generation, execution, and recovery of `task.commands`.

Related:

- `docs/policy-recovery.md`
- `docs/state-model.md`
- `docs/flow.md`
- `docs/operations.md`
- `docs/agent/planner.md`
- `docs/agent/worker.md`

## Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, When Entering from Verification Failure)

When tracing from verification failure, follow: state vocabulary -> transition -> owner -> implementation.

1. `docs/state-model.md` (`needs_rework` / `quota_wait`, etc.)
2. `docs/flow.md` (Worker failure handling and recovery transitions)
3. `docs/operations.md` (API procedures and operation shortcuts)
4. `docs/agent/README.md` (owning agent and implementation tracing path)

## 1. Overview

1. Planner generates task
2. Planner augments `task.commands` (per mode)
3. Worker executes commands in order
4. On failure, branches to verification recovery / policy recovery / rework

## 2. Planner Side

Planner verification command mode:

- `PLANNER_VERIFY_COMMAND_MODE=off|fallback|contract|llm|hybrid` (default: `hybrid`)

Main config:

- `PLANNER_VERIFY_CONTRACT_PATH` (default: `.opentiger/verify.contract.json`)
- `PLANNER_VERIFY_MAX_COMMANDS` (default: `4`)
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `PLANNER_VERIFY_AUGMENT_NONEMPTY`

### Verify Contract

Example `verify.contract.json`:

```json
{
  "commands": ["pnpm run check"],
  "byRole": {
    "tester": ["pnpm run test"]
  },
  "rules": [
    {
      "whenChangedAny": ["apps/api/**"],
      "commands": ["pnpm --filter @openTiger/api test"]
    }
  ]
}
```

## 3. Worker Side

Worker auto-completion mode:

- `WORKER_AUTO_VERIFY_MODE=off|fallback|contract|llm|hybrid` (default: `hybrid`)

Main config:

- `WORKER_VERIFY_CONTRACT_PATH` (default: `.opentiger/verify.contract.json`)
- `WORKER_AUTO_VERIFY_MAX_COMMANDS` (default: `4`)
- `WORKER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `WORKER_VERIFY_PLAN_PARSE_RETRIES`
- `WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS`
- `WORKER_VERIFY_SKIP_INVALID_AUTO_COMMAND` (default: `true`)

For docser, restricted to doc-safe commands (e.g. `pnpm run check`).

## 4. Execution Constraints

Verification commands run via direct spawn, not shell; the following are not supported:

- Command substitution: `$()`
- Shell operators: `|`, `&&`, `||`, `;`, `<`, `>`, `` ` ``

Explicit commands that are missing script or unsupported format may be skipped depending on conditions.

## 5. No-Change and Recovery

Worker implements:

- Retry on no-change failure
- Treat as no-op success when verification pass is confirmed even with no-change
- Recovery attempt on command failure

Main config:

- `WORKER_NO_CHANGE_RECOVERY_ATTEMPTS`
- `WORKER_NO_CHANGE_CONFIRM_MODE`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT`

## 6. Verification Recovery (Cycle Manager)

When a failed run is caused by verification command issues, Cycle Manager can adjust
`task.commands` and requeue the same task without entering policy recovery.

Supported adjustment reasons:

- `verification_command_missing_script`
  - Drops the failed explicit command to allow fallback verification.
- `verification_command_missing_make_target`
  - Drops failed `make <target>` verification command when target is unavailable.
- `verification_command_unsupported_format`
  - Drops unsupported explicit command syntax (e.g. shell operators / command substitution).
- `verification_command_sequence_issue`
  - Reorders conflicting command sequence where cleanup commands run before generated-artifact presence checks.
  - Scope is intentionally narrow: this applies only to explicit artifact checks (`test -f/-s ...`) on likely generated paths.
  - `grep`-style verification failures are not treated as sequence issues.

`grep` bracket-literal handling (`grep -q "\[...\]"`) is handled in Worker command parsing:

- The parser preserves non-special backslashes inside double quotes (for example `\[`).
- This prevents shell/direct-spawn interpretation drift and is separate from sequence recovery.

Requeue event payload includes:

- `reason` (adjustment reason)
- `recoveryRule` (applied transformation rule)
- `previousCommands`
- `nextCommands`

Worker persists structured failure metadata into `runs.error_meta`:

- `source` (for example: `verification`, `execution`)
- `failureCode` (for example: `verification_command_missing_script`)
- command context fields (`failedCommand`, `failedCommandSource`, `failedCommandStderr`) when available

Failure code vocabulary is defined centrally in `packages/core/src/failure-codes.ts`.

Cycle Manager and API both use shared classifier logic from `@openTiger/core`.
They prefer structured metadata (`errorMeta.failureCode`) and use message-regex fallback for
legacy runs without `error_meta` or for unknown codes.

Important classification behavior:

- `execution_failed` is not mapped to a fixed category by code alone.
- The classifier intentionally falls back to message-based signals so it can still classify into
  `permission`, `noop`, `setup`, and other concrete categories when possible.

Retry behavior for requeue:

- Setup/policy/test/model categories default to up to 3 retries.
- Repeated-signature escalation uses `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD` (default: `4`).

## 7. Relation to Policy Violation

When policy violation occurs during verification:

1. Deterministic allowedPaths adjustment
2. Optional LLM policy recovery (`allow`|`discard`|`deny`)
3. Discard + learn generated artifacts
4. If still unresolved -> `blocked(needs_rework)`

See `docs/policy-recovery.md` for details.

## 8. Operation Observation (Initial Triage)

| Symptom                       | First APIs                                         | What to check                                                              |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Command failure repeating     | `GET /runs`, `GET /tasks`, `GET /logs/all`         | Same command failing repeatedly, presence of recovery attempt              |
| No-change failure continuing  | `GET /runs/:id`, `GET /tasks/:id`                  | Whether no-op success is reached, retry count                              |
| Stuck on policy violation     | `GET /runs/:id`, `GET /tasks/:id`, `GET /logs/all` | Transition reason to `blocked(needs_rework)`, allowedPaths adjustment logs |
| Quota-related wait continuing | `GET /tasks`, `GET /runs`, `GET /logs/all`         | `blocked(quota_wait)` increase, whether cooldown recovery resumes          |

Notes:

- For overall operation check order, see checklist in `docs/operations.md`.
- For state vocabulary (`quota_wait`, `needs_rework`, etc.), see `docs/state-model.md`.
