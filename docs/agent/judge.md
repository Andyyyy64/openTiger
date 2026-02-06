# Judge Agent

最終更新: 2026-02-06

## 1. 役割

成功runを評価して、task を完了・再実行・隔離へ遷移させる。

## 2. 入力

- run（`status=success`）
- PR情報（git mode）または local diff（local mode）
- CI/policy/LLM評価結果

起動トリガ（Start preflight）:

- GitHub open PR がある
- または `blocked(awaiting_judge)` のtask backlog がある

## 3. 判定

- `approve`
- `request_changes`
- `needs_human`

## 4. 重要仕様

- 冪等性:
  - `runs.judgedAt IS NULL` のrunのみ対象
  - claim時に `judgementVersion` をインクリメント
- 対象task:
  - `status=blocked` のみ
- 非承認時:
  - 既定で task を `queued` へ戻す
  - requeue無効時は `blocked(needs_rework|needs_human)` を維持
- approveだがmerge不可:
  - 停滞防止のため再キュー

## 5. 主な設定

- `JUDGE_MODE=git|local|auto`
- `JUDGE_MODEL`
- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT`

## 6. 出力

- `events` へ review/requeue 記録
- run更新（失敗理由含む）
- task更新（`done`/`queued`/`blocked`）
- 必要に応じて docser task 生成
