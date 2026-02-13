# Operations Guide

このドキュメントは、openTiger を継続運用するための実務向け手順をまとめています。

## 1. 運用で見るべき状態

### 主要 task status

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

### 主要 blocked reason

- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `issue_linking`

`failed` と `retry countdown` が同時に見えるのは正常です。  
run は失敗結果、task は次回リトライ待機を示します。

## 2. Process 運用

### 起動/停止

- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

### process 名

固定:

- `planner`
- `dispatcher`
- `cycle-manager`
- `db-up`
- `db-down`
- `db-push`

動的:

- `judge`, `judge-2...`
- `worker-1...`
- `tester-1...`
- `docser-1...`

## 3. runtime hatch と self-heal

openTiger は runtime hatch（イベントベース）で process 自己復旧を制御します。

主要イベント:

- `system.runtime_hatch_armed`
- `system.runtime_hatch_disarmed`

用途:

- 実行系 process を「継続稼働対象」として扱うかを決定
- judge backlog 検知時の judge 自動再起動などに利用

CLI:

```bash
pnpm runtime:hatch:status
pnpm runtime:hatch:arm
pnpm runtime:hatch:disarm
```

## 4. 自動再起動・自己回復の関連 env

### process auto-restart

- `SYSTEM_PROCESS_AUTO_RESTART`
- `SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS`

### self-heal loop

- `SYSTEM_PROCESS_SELF_HEAL`
- `SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS`
- `SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS`
- `SYSTEM_AGENT_LIVENESS_WINDOW_MS`

### task リトライ

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `DISPATCH_RETRY_DELAY_MS`

### policy/rework 抑制

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`
- `AUTO_REWORK_MAX_DEPTH`

## 5. Cleanup の注意点

`POST /system/cleanup` は以下を実施します。

- queue を obliterate
- runtime テーブル（tasks/runs/artifacts/leases/events/cycles）を初期化
- agent 状態を `idle` へ更新

破壊的操作なので、通常運用時は限定的に使用してください。

## 6. ログ運用

### 参照

- `GET /logs/agents/:id`
- `GET /logs/cycle-manager`
- `GET /logs/all`

### クリア

- `POST /logs/clear`
  - open 中ファイルは truncate、未使用ファイルは削除

## 7. 障害時の一次切り分け

1. `tasks` で `blockReason` を確認
2. `runs/:id` でエラー本文と artifacts を確認
3. `judgements` で non-approve / merge failure を確認
4. `logs/all` で dispatcher / cycle-manager / judge / worker の相関を確認
5. 必要なら `stop-all` -> 再起動

## 8. sandbox 運用時の追加確認

- `EXECUTION_ENVIRONMENT=sandbox` の場合、worker/tester/docser は docker 実行
- `SANDBOX_DOCKER_IMAGE` と `SANDBOX_DOCKER_NETWORK` を確認
- Claude executor 利用時は host 認証ディレクトリマウントを確認
