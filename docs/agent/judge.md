# ジャッジ（Judge）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/mode.md`

## 1. Role

Judge は successful run を評価し、task を `done` へ収束させるか、再実行/再修正へ分岐させる責務を持ちます。

責務外:

- queued task の配布・lease 管理
- 実ファイル変更の実行

## 2. Mode Resolution

実行モードは次で決定されます。

- `JUDGE_MODE=git|local|auto`
- `auto` の場合は `REPO_MODE` に追従

## 3. Inputs

- successful run + artifacts (`pr` / `worktree`)
- CI / policy / LLM evaluator 結果
- task の retry context / lineage

## 4. Core Decisions

- `approve`
- `request_changes`

legacy `needs_human` は request_changes 系の回復フローへ正規化されます。

## 5. Post Decision

- approve + merge 成功 -> `done`
- non-approve -> retry または `needs_rework` へ昇格
- merge conflict -> `[AutoFix-Conflict]` task 作成を試行

## 6. Anti-loop / Recovery

- run claim idempotency (`judgedAt`, `judgementVersion`)
- non-approve circuit breaker
- doom loop circuit breaker
- awaiting_judge backlog の run 復元
- conflict 時の autofix fallback

## 7. Important Settings

- `JUDGE_MODE`
- `JUDGE_MODEL`
- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`
- `JUDGE_AUTO_FIX_ON_FAIL`
- `JUDGE_AUTO_FIX_MAX_ATTEMPTS`
- `JUDGE_AWAITING_RETRY_COOLDOWN_MS`
- `JUDGE_PR_MERGEABLE_PRECHECK_RETRIES`
- `JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS`
- `JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES`
- `JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY*`
