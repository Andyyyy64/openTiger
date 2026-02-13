# API Reference

openTiger API は Hono ベースで、Dashboard からも同じエンドポイントを利用します。  
ベース URL は通常 `http://localhost:4301` です。

関連:

- `docs/config.md`
- `docs/operations.md`
- `docs/state-model.md`
- `docs/agent/dispatcher.md`
- `docs/agent/cycle-manager.md`

## 1. 認証とレート制限

### 認証方式

- `X-API-Key` (`API_KEYS`)
- `Authorization: Bearer <token>` (`API_SECRET` または独自 validator)

認証スキップ:

- `/health*`
- `/webhook/github`（および `/api/webhook/github`）

system 制御系は `canControlSystem()` で許可判定されます。

- `api-key` / `bearer` は常に許可
- ローカル運用時は `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL !== "false"` で許可される設計

### レート制限

- 既定: 1分あたり 100 リクエスト
- Redis 利用可能時は Redis カウンタ、失敗時は in-memory にフォールバック

---

## 2. 運用目的別 API マップ

| 運用目的 | 主な API |
| --- | --- |
| ヘルス確認 | `GET /health`, `GET /health/ready` |
| 状態監視 | `GET /tasks`, `GET /runs`, `GET /judgements`, `GET /agents`, `GET /logs/all` |
| 設定変更 | `GET /config`, `PATCH /config` |
| 起動制御 | `POST /system/processes/:name/start`, `POST /system/processes/:name/stop`, `POST /system/processes/stop-all` |
| 起動前判定 | `POST /system/preflight` |
| 復旧・メンテナンス | `POST /system/cleanup`, `POST /logs/clear` |
| GitHub 連携 | `GET /system/github/auth`, `GET /system/github/repos`, `POST /system/github/repo`, `POST /webhook/github` |
| requirement 更新 | `GET /system/requirements`, `POST /system/requirements` |

補足:

- task/run の状態語彙（`queued`, `blocked`, `awaiting_judge` など）は `docs/state-model.md` を参照してください。

## 2.1 運用担当向け最小 API セット

障害切り分けや日次運用で、まず押さえる最小セットです。

| 用途 | API | 見るポイント |
| --- | --- | --- |
| 全体ヘルス | `GET /health/ready` | DB/Redis の疎通可否 |
| process 状態 | `GET /system/processes` | `running/stopped` の偏り、必要 process の欠落 |
| agent 稼働 | `GET /agents` | `offline` の偏り、role ごとの稼働数 |
| task 滞留 | `GET /tasks` | `queued` 固着、`blocked` の急増 |
| run 異常 | `GET /runs` | 同一エラーの連続 `failed`、`running` 長期化 |
| judge 詰まり | `GET /judgements` | non-approve の連鎖、未処理 backlog |
| 相関ログ | `GET /logs/all` | dispatcher/worker/judge/cycle-manager の時系列 |

運用時の確認順（シーケンス）は `docs/operations.md` の  
「変更後の確認チェックリスト」を一次参照にしてください。

---

## 3. 主要エンドポイント一覧

### Health

- `GET /health`
- `GET /health/ready`
  - DB と Redis の疎通確認を返します

### Config

- `GET /config`
  - `system_config` の現在値を返す
- `PATCH /config`
  - `{ updates: Record<string, string> }`
  - 未知キーは拒否

### Tasks

- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`

補足:

- failed/blocked タスクには `retry` 情報が付与されます（cooldown / reason / retryCount 等）

### Runs

- `GET /runs`
- `GET /runs/:id`
- `GET /runs/stats`
- `POST /runs`
- `PATCH /runs/:id`
- `POST /runs/:id/cancel`
- `POST /runs/:id/artifacts`

### Agents

- `GET /agents`
- `GET /agents/:id`
- `POST /agents`
- `POST /agents/:id/heartbeat`
- `DELETE /agents/:id`

### Plans

- `GET /plans`
  - `planner.plan_created` イベントから plan スナップショットを返す

### Judgements

- `GET /judgements`
- `GET /judgements/:id/diff`

### Logs

- `GET /logs/agents/:id`
- `GET /logs/cycle-manager`
- `GET /logs/all`
- `POST /logs/clear`

### Webhook

- `POST /webhook/github`
  - `GITHUB_WEBHOOK_SECRET` があれば署名検証を行う

実装上の現在挙動:

- 受信イベントは `events` テーブルへ記録
- `issues` / `pull_request` / `push` / `check_run` / `check_suite` を処理
- PR close+merge 時、PR body に `[task:<uuid>]` が含まれる場合は該当 task を `done` 更新
- それ以外は主に記録/通知用途で、planner/dispatcher の主駆動は `/system/preflight` 系にあります

---

## 4. System API

### 認証状態チェック

- `GET /system/github/auth`
- `GET /system/claude/auth?environment=host|sandbox`

### requirement 操作

- `GET /system/requirements`
- `POST /system/requirements`
  - canonical path `docs/requirement.md` へ同期
  - git repository の場合は snapshot commit/push を試行

### preflight / 起動判定

- `POST /system/preflight`
  - requirement content + local backlog + GitHub issue/PR backlog から推奨起動構成を返す

### process manager

- `GET /system/processes`
- `GET /system/processes/:name`
- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

### GitHub repository 操作

- `POST /system/github/repo`
  - repo 作成 + config 同期
- `GET /system/github/repos`
  - 認証ユーザーでアクセス可能な repo 一覧

### host 情報

- `GET /system/host/neofetch`
- `GET /system/host/context`

### メンテナンス

- `POST /system/cleanup`
  - runtime テーブルと queue を初期化

---

## 5. preflight の重要挙動

- Planner は次をすべて満たすときのみ推奨されます:
  - requirement が空でない
  - issue backlog なし
  - judge backlog なし
  - local task backlog なし
- issue -> task 自動生成は「明示 role」が必須です
  - label: `role:worker|role:tester|role:docser`
  - または body に `Agent:` / `Role:` 記述

## 6. 代表レスポンス例

### `POST /system/preflight`（抜粋）

```json
{
  "preflight": {
    "github": {
      "enabled": true,
      "openIssueCount": 3,
      "openPrCount": 1,
      "issueTaskBacklogCount": 2,
      "generatedTaskCount": 1,
      "warnings": []
    },
    "local": {
      "queuedTaskCount": 4,
      "runningTaskCount": 1,
      "failedTaskCount": 0,
      "blockedTaskCount": 2,
      "pendingJudgeTaskCount": 1
    }
  },
  "recommendations": {
    "startPlanner": false,
    "startDispatcher": true,
    "startJudge": true,
    "startCycleManager": true,
    "workerCount": 4,
    "testerCount": 4,
    "docserCount": 4,
    "plannerCount": 0,
    "judgeCount": 4,
    "reasons": ["Issue backlog detected (2)"]
  }
}
```

### `GET /system/processes`（抜粋）

```json
{
  "processes": [
    {
      "name": "dispatcher",
      "kind": "service",
      "status": "running",
      "supportsStop": true,
      "startedAt": "2026-02-13T10:00:00.000Z",
      "pid": 12345
    },
    {
      "name": "worker-1",
      "kind": "worker",
      "status": "running",
      "supportsStop": true
    }
  ]
}
```

---

## 7. 実装連携時の注意

- command 実行 API を外部から直接叩く設計ではなく、process manager 経由で制御します
- `stop-all` は running run を cancel/requeue し、agent 状態も更新します
- sandbox 実行時、worker/tester/docser の host process は通常起動しません
- `/system/*` と `/logs/clear` は system-control 権限での呼び出しを前提にしてください

運用トラブル時の補助資料:

- dispatch/lease 問題: `docs/agent/dispatcher.md`
- 収束/再計画問題: `docs/agent/cycle-manager.md`
