# Verification Recovery (Worker)

This document explains Worker-side verification command failure handling.

Related:

- [verification](../verification.md)
- [verify-recovery](../verify-recovery.md)
- [verify-recovery-cycle-manager](../verify-recovery-cycle-manager.md)
- [policy-recovery](../policy-recovery.md)
- [flow](../flow.md)

## 1. Scope

Worker-side responsibilities:

- Resolve verification failure codes from command output
- Decide whether failed commands can be skipped in-run
- Gate verify-recovery retries based on failure type
- Attempt in-process LLM-driven recovery before requeue
- Persist structured verification failure metadata

## 2. Failure Code Resolution

Worker maps command/output signals to verification-related failure codes.

Main codes:

- `verification_command_missing_script`
- `verification_command_no_test_files`
- `verification_command_missing_make_target`
- `verification_command_unsupported_format`
- `verification_command_sequence_issue`
- `setup_or_bootstrap_issue`
- `verification_command_failed`

`setup_or_bootstrap_issue` covers missing dependency / command-not-found /
runtime compatibility failure patterns.

## 3. Skip Rules in Current Run

Worker may continue verification after command failure under guarded conditions.

## 3.1 Explicit Command Skip

Config:

- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT` (default: `true`)

Typical skippable signals:

- missing script / missing package manifest
- unsupported command format
- related setup-like output where subsequent commands can still provide verification coverage

## 3.2 Auto Command Skip

Config:

- `WORKER_VERIFY_SKIP_INVALID_AUTO_COMMAND` (default: `true`)
- `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS` (default: `true`)
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY` (default: `true`)
- `WORKER_VERIFY_INLINE_COMMAND_RECOVERY_CANDIDATES` (default: `3`)

Behavior:

- Skip setup-like auto-command failures when later commands remain
- Allow non-blocking continuation after explicit-pass (last auto command failure case)
  when `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS=true`
- For workspace-wide recursive commands (for example `pnpm -r run typecheck`), retry in a
  single package scope candidate (derived from changed files or `allowedPaths`) before escalating
- If a final recursive workspace explicit command still fails, and earlier effective verification
  commands have already passed, treat it as non-blocking and continue
- For setup/bootstrap failures, attempt inline dependency bootstrap and replacement verification commands
  before promoting to rework.
- For outside-allowed policy violations, generated artifacts are discarded in-place and re-verified.
  Unknown file types are also discarded when they are untracked and outside allowed paths, so
  verification byproducts do not stall convergence.

## 3.3 LLM Inline Command Recovery

Config:

- `WORKER_VERIFY_LLM_INLINE_RECOVERY` (default: `true`)
- `WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS` (default: `3`)

When a verification command fails and is not skippable or recoverable by the
script-candidate-based inline recovery, the worker can call the LLM to make a
targeted fix and re-run the same failed command. This avoids the expensive full
verify-recovery loop (which re-runs all commands from scratch).

The LLM receives a focused hint containing the failed command and its stderr,
and is instructed to apply the smallest possible fix without restructuring code.
If an inline LLM execution attempt fails before re-running the command, that
execution failure summary is propagated into the next inline attempt hint.

If the LLM fix makes the command pass, verification continues to the next
command. If all LLM inline attempts fail, the failure is recorded and the
standard verify-recovery loop handles it.

## 4. Verify-Recovery Attempt Guard

Config:

- `WORKER_VERIFY_RECOVERY_ATTEMPTS` (default: `5`)
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT` (default: `true`)
- `WORKER_SETUP_IN_PROCESS_RECOVERY` (default: `true`)

Worker attempts in-process verify-recovery for most failure types, including
`setup_or_bootstrap_issue` (when `WORKER_SETUP_IN_PROCESS_RECOVERY=true`).

For setup/bootstrap failures, the recovery hint instructs the LLM to fix the
environment (install dependencies, add missing packages) rather than modify
source code.

When recovery execution itself fails, the failure context is propagated to the
next attempt as an additional hint, preventing repeated identical failures.

Set `WORKER_SETUP_IN_PROCESS_RECOVERY=false` to delegate setup failures
directly to Cycle Manager retry handling (legacy behavior).

## 5. Structured Failure Metadata

Worker stores structured failure metadata in `runs.error_meta`:

- `source` (e.g. `verification`, `execution`)
- `failureCode`
- command context (`failedCommand`, `failedCommandSource`, `failedCommandStderr`)

This structured metadata is consumed by shared classifier and Cycle Manager recovery logic.

## 6. Implementation Reference (Source of Truth)

- `apps/worker/src/steps/verify/verify-changes.ts`
- `apps/worker/src/steps/verify/types.ts`
- `apps/worker/src/worker-runner-verification.ts`
- `apps/worker/src/worker-runner-utils.ts`
- `packages/core/src/failure-codes.ts`
- `packages/core/src/failure-classifier.ts`
