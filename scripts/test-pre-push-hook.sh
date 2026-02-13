#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Not inside a git repository."
  exit 1
fi

hook_path="$repo_root/.githooks/pre-push"
if [[ ! -x "$hook_path" ]]; then
  echo "pre-push hook is not executable: $hook_path"
  exit 1
fi

run_hook() {
  local branch="$1"
  local allow_main_push="$2"
  local stdin_payload="$3"
  local output_file="$4"

  if [[ -n "$stdin_payload" ]]; then
    printf "%s\n" "$stdin_payload" | OPENTIGER_GIT_HOOK_BRANCH="$branch" ALLOW_MAIN_PUSH="$allow_main_push" "$hook_path" origin test >"$output_file" 2>&1
  else
    OPENTIGER_GIT_HOOK_BRANCH="$branch" ALLOW_MAIN_PUSH="$allow_main_push" "$hook_path" origin test >"$output_file" 2>&1 </dev/null
  fi
}

assert_case() {
  local case_name="$1"
  local expected_status="$2"
  local branch="$3"
  local allow_main_push="$4"
  local stdin_payload="$5"
  local expected_message="$6"

  local output_file
  output_file="$(mktemp)"
  set +e
  run_hook "$branch" "$allow_main_push" "$stdin_payload" "$output_file"
  local status=$?
  set -e
  local output
  output="$(cat "$output_file")"
  rm -f "$output_file"

  if [[ $status -ne $expected_status ]]; then
    echo "Case failed: $case_name"
    echo "Expected status: $expected_status"
    echo "Actual status:   $status"
    echo "Output:"
    echo "$output"
    exit 1
  fi

  if [[ -n "$expected_message" && "$output" != *"$expected_message"* ]]; then
    echo "Case failed: $case_name"
    echo "Expected message containing: $expected_message"
    echo "Actual output:"
    echo "$output"
    exit 1
  fi

  echo "PASS: $case_name"
}

assert_case "feature branch push allowed" 0 "cursor/test" "0" "" ""
assert_case "main branch push blocked" 1 "main" "0" "" "Push blocked: direct pushes to 'main' are disabled."
assert_case "refspec push to main blocked" 1 "cursor/test" "0" "refs/heads/cursor/test 111 refs/heads/main 000" "Push blocked: direct updates to 'main' are disabled."
assert_case "main branch push can be bypassed" 0 "main" "1" "" "Bypassing protected-branch push guard for 'main' because ALLOW_MAIN_PUSH=1"
assert_case "refspec push can be bypassed" 0 "cursor/test" "1" "refs/heads/cursor/test 111 refs/heads/main 000" "Bypassing protected-branch push guard for 'cursor/test' because ALLOW_MAIN_PUSH=1"

echo "All pre-push hook guard tests passed."
