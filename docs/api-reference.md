# API Reference

openTiger API は Hono ベースで、Dashboard からも同じエンドポイントを利用します。  
ベース URL は通常 `http://localhost:4301` です。

関連:

- `docs/config.md`
- `docs/operations.md`

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

## 2. 主要エンドポイント一覧

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

---

## 3. System API

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

## 4. preflight の重要挙動

- Planner は次をすべて満たすときのみ推奨されます:
  - requirement が空でない
  - issue backlog なし
  - judge backlog なし
  - local task backlog なし
- issue -> task 自動生成は「明示 role」が必須です
  - label: `role:worker|role:tester|role:docser`
  - または body に `Agent:` / `Role:` 記述

## 5. 代表レスポンス例

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

## 6. 実装連携時の注意

- command 実行 API を外部から直接叩く設計ではなく、process manager 経由で制御します
- `stop-all` は running run を cancel/requeue し、agent 状態も更新します
- sandbox 実行時、worker/tester/docser の host process は通常起動しません
