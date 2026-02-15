# Verification Command Strategy

openTiger handles verification commands in both Planner and Worker.  
This document summarizes the implementation spec for generation, execution, and recovery of `task.commands`.

Related:

- `docs/policy-recovery.md`
- `docs/verify-recovery.md`
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
- `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS` (default: `true`)
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY` (default: `true`)
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY_CANDIDATES` (default: `3`)

For docser, restricted to doc-safe commands (e.g. `pnpm run check`).

## 4. Execution Constraints

Verification commands run via direct spawn, not shell; the following are not supported:

- Command substitution: `$()`
- Shell operators: `|`, `||`, `;`, `<`, `>`, `` ` ``

Notes:

- `&&` is supported only as a verification-command chain splitter.
- `cd <path> && <command>` is interpreted as directory switch + subsequent command execution (inside repo).
- Shell builtins (for example `source`, `export`) are not executable via spawn and are treated as setup/format failure.

Explicit commands that are missing script or unsupported format may be skipped depending on conditions.

For setup/bootstrap failures (for example `command not found`, missing dependency, runtime mismatch),
worker attempts in-place inline recovery before escalating to rework:

- dependency bootstrap commands inferred from repo package manager (for example `pnpm install --frozen-lockfile`)
- replacement verification commands derived from available `package.json` scripts

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

Default recovery attempts:

- `WORKER_NO_CHANGE_RECOVERY_ATTEMPTS=2`
- `WORKER_POLICY_RECOVERY_ATTEMPTS=2`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS=2`

## 6. Verification Recovery (Overview)

Verification recovery now has a dedicated spec:

- `docs/verify-recovery.md`
- `docs/verify-recovery-worker.md`
- `docs/verify-recovery-cycle-manager.md`

This includes:

- Worker-side failure code resolution and skip/continue rules
- Cycle Manager command adjustment for verification failures
- Setup/bootstrap retry handling and judge-missing-run fallback behavior
- Structured failure metadata (`runs.error_meta`) and queue requeue reasons

`grep` bracket-literal handling (`grep -q "\[...\]"`) remains a Worker command parser behavior:

- The parser preserves non-special backslashes inside double quotes (for example `\[`).
- This avoids shell/direct-spawn interpretation drift.

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
