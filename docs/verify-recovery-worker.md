# Verification Recovery (Worker)

This document explains Worker-side verification command failure handling.

Related:

- `docs/verification.md`
- `docs/verify-recovery.md`
- `docs/verify-recovery-cycle-manager.md`
- `docs/policy-recovery.md`
- `docs/flow.md`

## 1. Scope

Worker-side responsibilities:

- Resolve verification failure codes from command output
- Decide whether failed commands can be skipped in-run
- Gate verify-recovery retries based on failure type
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

Behavior:

- Skip setup-like auto-command failures when later commands remain
- Allow non-blocking continuation after explicit-pass (last auto command failure case)
  when `WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS=true`

## 4. Verify-Recovery Attempt Guard

Worker does not attempt verify-recovery retries for `setup_or_bootstrap_issue`.
Those failures are delegated to Cycle Manager retry handling.

## 5. Structured Failure Metadata

Worker stores structured failure metadata in `runs.error_meta`:

- `source` (e.g. `verification`, `execution`)
- `failureCode`
- command context (`failedCommand`, `failedCommandSource`, `failedCommandStderr`)

This structured metadata is consumed by shared classifier and Cycle Manager recovery logic.

## 6. Implementation Reference (Source of Truth)

- `apps/worker/src/steps/verify/verify-changes.ts`
- `apps/worker/src/worker-runner-utils.ts`
- `packages/core/src/failure-codes.ts`
- `packages/core/src/failure-classifier.ts`
