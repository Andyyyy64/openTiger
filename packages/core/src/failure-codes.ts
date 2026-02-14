export const FAILURE_CODE = {
  NO_ACTIONABLE_CHANGES: "no_actionable_changes",
  POLICY_VIOLATION: "policy_violation",
  VERIFICATION_COMMAND_MISSING_SCRIPT: "verification_command_missing_script",
  VERIFICATION_COMMAND_MISSING_MAKE_TARGET: "verification_command_missing_make_target",
  VERIFICATION_COMMAND_UNSUPPORTED_FORMAT: "verification_command_unsupported_format",
  VERIFICATION_COMMAND_SEQUENCE_ISSUE: "verification_command_sequence_issue",
  VERIFICATION_COMMAND_FAILED: "verification_command_failed",
  SETUP_OR_BOOTSTRAP_ISSUE: "setup_or_bootstrap_issue",
  ENVIRONMENT_ISSUE: "environment_issue",
  TEST_FAILURE: "test_failure",
  TRANSIENT_OR_FLAKY_FAILURE: "transient_or_flaky_failure",
  MODEL_DOOM_LOOP: "model_doom_loop",
  MODEL_OR_UNKNOWN_FAILURE: "model_or_unknown_failure",
  EXTERNAL_DIRECTORY_PERMISSION_PROMPT: "external_directory_permission_prompt",
  QUOTA_FAILURE: "quota_failure",
  EXECUTION_FAILED: "execution_failed",
} as const;

export type FailureCode = (typeof FAILURE_CODE)[keyof typeof FAILURE_CODE];

export type VerificationFailureCode =
  | typeof FAILURE_CODE.NO_ACTIONABLE_CHANGES
  | typeof FAILURE_CODE.POLICY_VIOLATION
  | typeof FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT
  | typeof FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET
  | typeof FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT
  | typeof FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE
  | typeof FAILURE_CODE.VERIFICATION_COMMAND_FAILED;

export const VERIFICATION_RECOVERY_FAILURE_CODES = [
  FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT,
  FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET,
  FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT,
  FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE,
] as const;

export type VerificationRecoveryFailureCode = (typeof VERIFICATION_RECOVERY_FAILURE_CODES)[number];

const VERIFICATION_RECOVERY_FAILURE_CODE_SET = new Set<string>(VERIFICATION_RECOVERY_FAILURE_CODES);

export function isVerificationRecoveryFailureCode(
  value: string,
): value is VerificationRecoveryFailureCode {
  return VERIFICATION_RECOVERY_FAILURE_CODE_SET.has(value);
}
