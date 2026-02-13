# Cycle Manager Agent

関連:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/operations.md`

## 1. Role

Cycle Manager は長時間運用を前提に、システム全体の収束を維持します。  
監視・クリーンアップ・再計画（replan）を周期実行し、停止しにくい運用を支えます。

## 2. Runtime Loops

- monitor loop
  - cycle 終了条件判定
  - anomaly 検知
  - cost 上限監視
  - backlog 枯渇時の issue preflight / replan 判定
- cleanup loop
  - expired lease / offline agent / stuck run の回復
  - failed / blocked task の cooldown 後 requeue
- stats loop
  - cycle stats と system state の更新

## 3. Cycle Lifecycle

- 起動時に既存 `running` cycle を復元（なければ auto-start）
- 終了条件:
  - 経過時間上限
  - 完了タスク数上限
  - failure rate 上限
- cycle 終了時は必要に応じて cleanup 後に次 cycle を開始

## 4. Anomaly / Recovery

- 監視対象:
  - high failure rate
  - cost spike
  - stuck task
  - no progress
  - agent timeout
- `stuck_task` など一部 critical anomaly では cycle restart を実施
- anomaly は重複通知 cooldown を持つ

## 5. Replan and Backlog Policy

- task backlog が空になった後、まず `/system/preflight` で issue backlog を同期
- issue backlog がある間は replan を延期
- backlog が空で、かつ planner idle など条件を満たす場合のみ replan
- requirement hash + repo head を署名化し、設定により no-diff replan を抑止

## 6. CLI Commands

- `status`
- `anomalies`
- `clear-anomalies`
- `end-cycle`
- `new-cycle`
- `cleanup`

## 7. Important Settings

- `MONITOR_INTERVAL_MS`
- `CLEANUP_INTERVAL_MS`
- `STATS_INTERVAL_MS`
- `AUTO_START_CYCLE`
- `AUTO_REPLAN`
- `REPLAN_INTERVAL_MS`
- `REPLAN_REQUIREMENT_PATH`
- `REPLAN_COMMAND`
- `SYSTEM_API_BASE_URL`
- `ISSUE_SYNC_INTERVAL_MS`
- `ISSUE_SYNC_TIMEOUT_MS`
- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `STUCK_RUN_TIMEOUT_MS`
- `CYCLE_MAX_DURATION_MS`
- `CYCLE_MAX_TASKS`
- `CYCLE_MAX_FAILURE_RATE`
