# Verification Recovery (Cycle Manager)

This document explains Cycle Manager-side verification recovery and requeue behavior.

Related:

- [verification](../verification.md)
- [verify-recovery](../verify-recovery.md)
- [verify-recovery-worker](../verify-recovery-worker.md)
- [policy-recovery](../policy-recovery.md)
- [flow](../flow.md)

## 1. Scope

Cycle Manager-side responsibilities:

- Requeue failed tasks with verification command adjustment
- Requeue blocked tasks based on block reason and failure classification
- Apply setup/bootstrap retry policy for blocked rework tasks
- Handle judge-review task fallback when judge run is missing

## 2. Failed Task Requeue (`status=failed`)

## 2.1 Judge-Review Routing

For judge-review tasks:

- If pending/recoverable judge run exists:
  - route to `blocked(awaiting_judge)`
- If both missing:
  - fall back to standard failed-task retry flow

## 2.2 Verification Command Adjustment

If failure reason is verification-recovery compatible, adjust `task.commands`
and requeue same task to `queued`.

Adjustment targets:

- `verification_command_missing_script`
- `verification_command_no_test_files`
- `verification_command_missing_make_target`
- `verification_command_unsupported_format`
- `verification_command_sequence_issue`

Typical recovery action:

- drop failed explicit command
- or reorder sequence for narrow command-order issues

## 3. Blocked Task Requeue (`status=blocked`)

## 3.1 `blocked(needs_rework)`

- Judge-review task:
  - pending/restorable judge run -> keep `blocked(awaiting_judge)`
  - missing judge run -> requeue to `queued`
- `setup_or_bootstrap_issue`:
  - in-place requeue to `queued` with setup category retry limit
- verification-recovery failure code:
  - apply command adjustment and requeue to `queued`

## 3.2 `blocked(awaiting_judge)`

- Keep blocked when pending judge run exists
- Restore latest judgable successful run when possible
- If no run can be restored:
  - judge-review task -> requeue to `queued` (`awaiting_judge_missing_run_retry`)
  - other task -> timeout requeue to `queued` (`awaiting_judge_timeout_retry`)

## 4. Representative Requeue Reasons

Verification adjustment reasons:

- `verification_command_missing_script_adjusted`
- `verification_command_no_test_files_adjusted`
- `verification_command_missing_make_target_adjusted`
- `verification_command_unsupported_format_adjusted`
- `verification_command_sequence_adjusted`
- `verification_command_missing_script_adjusted_from_blocked`
- `verification_command_no_test_files_adjusted_from_blocked`
- `verification_command_missing_make_target_adjusted_from_blocked`
- `verification_command_unsupported_format_adjusted_from_blocked`
- `verification_command_sequence_adjusted_from_blocked`

Blocked/judge/setup routing reasons:

- `setup_or_bootstrap_retry_from_blocked`
- `pr_review_needs_rework_to_awaiting_judge`
- `pr_review_needs_rework_run_restored`
- `pr_review_needs_rework_missing_run_retry`
- `awaiting_judge_run_restored`
- `awaiting_judge_missing_run_retry`
- `awaiting_judge_timeout_retry`

## 5. Main Configuration

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD`
- `BLOCKED_NEEDS_REWORK_IN_PLACE_RETRY_LIMIT` (default: `5`, `-1` for unlimited)
- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES` (default: `2`)
- `AUTO_REWORK_MAX_DEPTH` (default: `2`)

## 6. Remaining Escalation Cases (Expected)

These are the main "still escalates" cases after in-run and in-place retries:

- non-retryable failures
  - e.g. permission/auth failures that classifier marks `retryable=false`
- repeated identical failure signature
  - after repeated same-signature failures, task is escalated with `reason=repeated_same_failure_signature`
- policy violation with no safe recovery path
  - when no safe `allowedPaths` expansion candidate exists and suppression is exhausted,
    policy rework split is suppressed and task is cancelled

## 7. Implementation Reference (Source of Truth)

- `apps/cycle-manager/src/cleaners/cleanup-retry/requeue-failed.ts`
- `apps/cycle-manager/src/cleaners/cleanup-retry/requeue-blocked.ts`
- `apps/cycle-manager/src/cleaners/cleanup-retry/task-context.ts`
- `apps/cycle-manager/src/cleaners/cleanup-retry/retry-policy.ts`
- `packages/core/src/failure-codes.ts`
- `packages/core/src/failure-classifier.ts`
