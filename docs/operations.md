# Operations Guide

このドキュメントは、openTiger を継続運用するための実務向け手順をまとめています。

関連:

- `docs/flow.md`
- `docs/state-model.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/agent/dispatcher.md`
- `docs/agent/cycle-manager.md`

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

`stop-all` の実装挙動:

- managed process 停止
- orphan system process の強制終了試行
- `runs.status=running` を `cancelled` に更新
- 対応する `tasks.status=running` を `queued` へ戻す
- 対応 lease を解放
- 実行系 agent を `offline` 更新
- runtime hatch を disarm

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

使い分け:

- `stop-all`: 実行中プロセス停止 + running タスクの安全側巻き戻し
- `cleanup`: データ/キューの初期化（履歴を消す）

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

## 8. 症状別の確認先

- task が `queued` から進まない
  - `dispatcher` の稼働状態、lease 異常、role 別 idle agent 数を確認
  - 参照: `docs/agent/dispatcher.md`
- `awaiting_judge` が長時間解消しない
  - judge process と pending judge run の有無を確認
  - 参照: `docs/agent/judge.md`
- 失敗後に復帰しない
  - cycle-manager の cleanup/requeue 実行ログを確認
  - 参照: `docs/agent/cycle-manager.md`
- Planner が再起動しない
  - backlog gate（issue/pr/local task）と replan 条件を確認
  - 参照: `docs/startup-patterns.md`

## 9. sandbox 運用時の追加確認

- `EXECUTION_ENVIRONMENT=sandbox` の場合、worker/tester/docser は docker 実行
- `SANDBOX_DOCKER_IMAGE` と `SANDBOX_DOCKER_NETWORK` を確認
- Claude executor 利用時は host 認証ディレクトリマウントを確認

## 10. 設定変更時の安全な再起動手順

前提:

- まず `docs/config.md` の「設定変更の影響マップ」で対象コンポーネントを確認する
- 影響範囲が狭い場合は `stop-all` ではなく、対象プロセスのみ再起動する

### 10.1 部分再起動の基本順

1. 影響を受ける process を `stop`
2. 依存先から順に `start`（制御系 -> 実行系）
3. `tasks/runs/logs` で復帰確認

推奨順（一般形）:

- `cycle-manager` / `dispatcher` / `judge` を先に再起動
- 次に `worker/tester/docser` を再起動

### 10.2 代表パターン

- `DISPATCH_*` / `MAX_CONCURRENT_WORKERS` を変更した場合
  - `dispatcher` を再起動
- `WORKER_*` / `TESTER_*` / `DOCSER_*` / `LLM_EXECUTOR` を変更した場合
  - 対象 role の agent（worker/tester/docser）を再起動
- `JUDGE_*` / `JUDGE_MODE` を変更した場合
  - `judge` を再起動
- `AUTO_REPLAN` / `REPLAN_*` / `FAILED_TASK_*` を変更した場合
  - `cycle-manager` を再起動
- `EXECUTION_ENVIRONMENT` / `SANDBOX_DOCKER_*` を変更した場合
  - `dispatcher` と実行系 agent を再起動

### 10.3 `stop-all` を使うべきケース

- 影響範囲を切り分けられない大規模設定変更
- process 状態が不整合で、部分再起動では収束しない場合
- 実行中 task を一度安全側に巻き戻して仕切り直したい場合
