# 運用ガイド

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

### `retry.reason` の一次判断

`GET /tasks` の `retry.reason` は、次のように使い分けると切り分けが速くなります。

| reason | まず見る先 |
| --- | --- |
| `awaiting_judge` | `GET /judgements`, `GET /system/processes`, `GET /logs/all` |
| `quota_wait` | `GET /tasks`, `GET /runs`, `GET /logs/all` |
| `needs_rework` | `GET /runs`, `GET /judgements`, `GET /logs/all` |
| `cooldown_pending` / `retry_due` | `GET /tasks` の `retryAt` / `retryInSeconds` |

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

### プロセス名

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

CLIコマンド:

```bash
pnpm runtime:hatch:status
pnpm runtime:hatch:arm
pnpm runtime:hatch:disarm
```

## 4. 自動再起動・自己回復の関連 env

### プロセス自動再起動

- `SYSTEM_PROCESS_AUTO_RESTART`
- `SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS`

### 自己回復ループ（self-heal）

- `SYSTEM_PROCESS_SELF_HEAL`
- `SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS`
- `SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS`
- `SYSTEM_AGENT_LIVENESS_WINDOW_MS`

### タスクリトライ

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `DISPATCH_RETRY_DELAY_MS`

### ポリシー／リワーク抑制（policy/rework）

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

症状から最短で一次診断したい場合は `docs/state-model.md` の「状態遷移で詰まりやすいパターン（一次診断）」を先に確認してください。

- task が `queued` から進まない
  - `dispatcher` の稼働状態、lease 異常、role 別 idle agent 数を確認
  - 参照: `docs/agent/dispatcher.md`
- `awaiting_judge` が長時間解消しない
  - judge process と pending judge run の有無を確認
  - 参照: `docs/agent/judge.md`
- 失敗後に復帰しない
  - cycle-manager の cleanup/requeue 実行ログを確認
  - 参照: `docs/agent/cycle-manager.md`
- verification command 失敗が繰り返される
  - run の失敗内容と verification recovery の有無を確認
  - 参照: `docs/verification.md`
- task が `issue_linking` で止まり続ける
  - issue 連携情報の解決失敗や import 未収束を確認し、必要に応じて preflight を再実行
  - 参照: `docs/startup-patterns.md`
- Planner が再起動しない
  - backlog gate（issue/pr/local task）と replan 条件を確認
  - 参照: `docs/startup-patterns.md`

補足:

- 担当 agent の切り分けで迷う場合は `docs/agent/README.md` の FAQ も参照してください。

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

## 11. 変更後の確認チェックリスト

設定変更や再起動後は、以下を順に確認すると反映漏れを検知しやすくなります。

### 11.0 対応 API（早見表）

| 確認観点 | API |
| --- | --- |
| process 状態 | `GET /system/processes` |
| agent 状態 | `GET /agents` |
| task 滞留 | `GET /tasks` |
| run 異常 | `GET /runs` |
| 相関ログ | `GET /logs/all` |

### 11.1 Process 状態

- `GET /system/processes`
  - 対象 process が `running` で復帰している
  - 意図しない process が `stopped` のまま残っていない

### 11.2 Agent 状態

- `GET /agents`
  - 再起動した role の agent が再登録されている
  - `offline` が継続し続ける agent がない
  - `planner/worker/tester/docser/judge` が対象（Dispatcher/Cycle Manager は `GET /system/processes` で確認）

### 11.3 Task / Run の収束

- `GET /tasks`
  - `running` が長時間固定されていない
  - `blocked` が想定外に増えていない
- `GET /runs`
  - 再起動直後の run が連続 `failed` になっていない

### 11.4 ログ確認

- `GET /logs/all`
  - 対象 process で設定値読込エラーが出ていない
  - Dispatcher/Worker/Judge/Cycle Manager の heartbeat が継続している

### 11.5 判定の目安

- 正常:
  - queue が流れ、`queued -> running -> done/blocked` の遷移が再開
  - `awaiting_judge` backlog が増え続けない
- 要追加調査:
  - 同一エラーで `failed` が連続
  - 特定 role だけ agent が復帰しない
  - `quota_wait`/`needs_rework` が急増する

### 11.6 最小確認コマンド例（curl）

認証が必要な環境では `X-API-Key` または `Authorization: Bearer` を付与します。

```bash
# 例: APIキー利用時
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/health/ready
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/system/processes
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/agents
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/tasks
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/runs
curl -s -H "X-API-Key: $API_KEY" http://localhost:4301/logs/all
```
