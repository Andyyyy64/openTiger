# ディスパッチャー（Dispatcher）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/mode.md`

## 1. 役割

Dispatcher は `queued` task を安全に `running` へ進め、適切な実行 agent へ割り当てます。  
同時に lease/heartbeat を監視し、重複実行や取りこぼしを抑制します。

責務外:

- task 内容の実装（コード変更）
- run 成果物の approve/rework 判定

## 2. 入力

- `tasks` / `runs` / `leases` / `agents` の現在状態
- task の `priority`, `dependencies`, `targetArea`, `role`
- 実行モード（`LAUNCH_MODE=process|docker`）
- リポジトリ実行モード（`REPO_MODE=git|local`）

## 3. 配布パイプライン

1. lease 異常と孤立した running task を先に回復
2. 利用可能スロットを計算（busy agent 数 + 上限）
3. `queued` task を収集し、依存関係/競合でフィルタ
4. 優先度スコアで並べ替え
5. role に一致する idle agent を選択
6. lease 取得 + `queued -> running` を原子的に更新
7. worker 起動（queue enqueue または docker 起動）

## 4. 選択ロジックとガードレール

- `awaiting_judge` backlog は観測し、設定により hard block 可能
- PR review 専用 task が `queued` に紛れた場合は `blocked(awaiting_judge)` へ戻す
- recent failure/cancel は cooldown 中の再配布を抑止
- `targetArea` 衝突タスクは同時実行しない
- `dependencies` 未解決タスクは配布しない

## 5. 回復動作

- expired lease を解放し task を `queued` へ戻す
- queued task に残る dangling lease を回収
- `running` だが active run が無い task を回復
- heartbeat が途切れた agent の lease を reclaim
- `quota_wait` backlog 検知時は同時実行数を一時的に 1 に制限

## 6. 起動モード

- `process`:
  - 常駐 worker への agent 専用 queue に enqueue
  - Dispatcher は新規プロセスを毎回起動しない
- `docker`:
  - task ごとに worker container を起動
  - Docker image/network とログ mount を利用

## 7. 主な設定

- `POLL_INTERVAL_MS`
- `MAX_CONCURRENT_WORKERS`
- `LAUNCH_MODE`
- `DISPATCH_MAX_POLL_INTERVAL_MS`
- `DISPATCH_NO_IDLE_LOG_INTERVAL_MS`
- `DISPATCH_BLOCK_ON_AWAITING_JUDGE`
- `DISPATCH_RETRY_DELAY_MS`
- `DISPATCH_AGENT_HEARTBEAT_TIMEOUT_SECONDS`
- `DISPATCH_AGENT_RUNNING_RUN_GRACE_MS`
- `SANDBOX_DOCKER_IMAGE`
- `SANDBOX_DOCKER_NETWORK`
