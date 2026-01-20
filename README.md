# h1ve（ハイブ）

**AI Agent Orchestration System for Autonomous Coding**

数十のAIエージェントを協調させ、自律的にコードを積み上げるオーケストレーションシステム。  
[Cursor Research: Scaling Long-Running Autonomous Coding](https://cursor.com/ja/blog/scaling-agents) の設計思想を、実運用可能な形で実装する。

---

## 概要

h1veは、AIエージェントを「開発チーム」として機能させるためのオーケストレーション基盤。  
人間が要件・制約・完了条件を定義すると、複数のエージェントが自律的にタスクを分割・実装・検証・PRを作成する。

### できること

- **自律的なタスク分割**: 曖昧な要件から具体的な実装タスクへ分解
- **並列実行**: 10〜50のエージェントが同時に作業
- **品質ゲート**: CI/テスト/ポリシーによる自動判定
- **段階的デプロイ**: PR → 自動マージ → staging → 本番（条件付き）

### できないこと（現時点）

- 「〇〇作って」だけで完全自動（要件定義は必要）
- 100%の精度保証（人間のレビューは推奨）
- 既存の複雑なレガシーコードの完全理解

---

## 設計思想

### Cursor Research との対応

Cursorの研究で示された「役割分離パイプライン」を忠実に実装する。

| Cursor Research | h1ve |
|-----------------|------|
| Planner agent | `apps/planner` - タスク生成・分割 |
| Worker agent | `apps/worker` - 実装・PR作成 |
| Judge agent | `apps/judge` - 採用/差し戻し判定 |
| Shared state | PostgreSQL (tasks/runs/artifacts) |
| Lock問題回避 | 期限付きリース（lease） |
| Iteration reset | Cycle Manager |

### 核となる設計原則

#### 1. Workerは協調しない

```
❌ Worker同士がチャットして調整
✅ Workerはタスクを受けたら完了だけに集中
```

協調はPlanner/Judgeが担当。Workerは「1タスク完了」に専念する。

#### 2. 成功条件は機械判定

```
❌ 「動いた気がする」
✅ テスト通過 / 型チェック / lint / CI green
```

Judgeが判定できない曖昧なタスクは作らない。

#### 3. クリーン再スタート

```
❌ 延々と作業を続ける
✅ 定期的にリセット（ドリフト対策）
```

長時間運用では、エージェントが「勝手な前提」を積み上げる。  
サイクルごとにクリーンな状態から再開する。

#### 4. ロックではなくリース

```
❌ ロック（保持したまま死ぬと詰む）
✅ リース（期限切れで自動回収）
```

エージェントが異常終了しても、システムは回復できる。

#### 5. 冪等性と再試行

```
❌ 失敗したら手動介入が必要
✅ 同じタスクを何度実行しても同じ（安全な）結果になる
```

PRの重複作成防止や、ブランチの強制上書きなど、リトライを前提とした設計を行う。

#### 6. 領域別並列制御 (Isolated Ownership)

```
❌ 全てのWorkerが全ファイルを触る
✅ 担当領域（target_area）ごとに並列度を制限
```

Dispatcherがタスクの「担当領域」を理解し、同じ領域への同時変更によるコンフリクトを最小化する。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                         h1ve Orchestrator                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────┐    ┌────────────┐    ┌─────────┐    ┌─────────┐   │
│  │ Planner │───▶│ Dispatcher │───▶│ Workers │───▶│  Judge  │   │
│  └─────────┘    └────────────┘    └─────────┘    └─────────┘   │
│       │                                                │         │
│       │         ┌──────────────────────────────────────┘         │
│       │         │                                                 │
│       ▼         ▼                                                 │
│  ┌─────────────────┐                                             │
│  │   Cycle Manager  │  ← クリーン再スタート                       │
│  └─────────────────┘                                             │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│                          State Layer                              │
│  ┌──────────┐  ┌───────┐  ┌───────────┐  ┌────────────────┐    │
│  │ Postgres │  │ Redis │  │  GitHub   │  │  Claude Code   │    │
│  │  (状態)   │  │(Queue)│  │ (PR/CI)   │  │ (実行エンジン)  │    │
│  └──────────┘  └───────┘  └───────────┘  └────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### データフロー

```
1. 要件定義 (requirement.md)
       │
       ▼
2. Planner: タスク分割 → tasks テーブル
       │
       ▼
3. Dispatcher: タスク割当 → lease発行 → Worker起動
       │
       ▼
4. Worker: Claude Code実行 → コード変更 → PR作成
       │
       ▼
5. Judge: CI結果 + ポリシー + LLMレビュー → 採用/差し戻し
       │
       ▼
6. Cycle Manager: 定期リセット → 次サイクル開始
```

---

## ディレクトリ構成

```
h1ve/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── docker-compose.yml
├── .env.example
│
├── apps/
│   ├── api/                      # 管理API（Hono）
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   │   ├── tasks.ts      # タスクCRUD
│   │   │   │   ├── runs.ts       # 実行履歴
│   │   │   │   ├── agents.ts     # エージェント管理
│   │   │   │   └── webhook.ts    # GitHub Webhook
│   │   │   └── middleware/
│   │   ├── test/
│   │   └── Dockerfile
│   │
│   ├── dispatcher/               # タスク割当
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   └── scheduler/
│   │   │       ├── lease.ts      # リース管理
│   │   │       ├── priority.ts   # 優先度計算
│   │   │       └── deps.ts       # 依存関係解決
│   │   └── Dockerfile
│   │
│   ├── worker/                   # 実行エンジン
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── steps/            # 実行ステップ
│   │   │   │   ├── checkout.ts
│   │   │   │   ├── branch.ts
│   │   │   │   ├── execute.ts    # Claude Code実行
│   │   │   │   ├── verify.ts     # テスト実行
│   │   │   │   ├── commit.ts
│   │   │   │   └── pr.ts
│   │   │   └── sandbox/
│   │   │       └── docker.ts     # 実行隔離
│   │   ├── instructions/         # Claude Code用プロンプト
│   │   │   ├── base.md
│   │   │   └── coding.md
│   │   └── Dockerfile
│   │
│   ├── planner/                  # タスク生成
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   └── strategies/
│   │   │       ├── from-issue.ts
│   │   │       └── from-requirement.ts
│   │   ├── instructions/
│   │   │   └── planning.md
│   │   └── Dockerfile
│   │
│   ├── judge/                    # 採用判定
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   └── evaluators/
│   │   │       ├── ci.ts         # CI結果評価
│   │   │       ├── policy.ts     # ポリシー検証
│   │   │       └── llm.ts        # LLMレビュー
│   │   ├── instructions/
│   │   │   └── review.md
│   │   └── Dockerfile
│   │
│   └── dashboard/                # 可視化UI（後回し可）
│       └── ...
│
├── packages/
│   ├── core/                     # ドメインモデル
│   │   ├── src/
│   │   │   ├── domain/
│   │   │   │   ├── task.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── agent.ts
│   │   │   │   └── policy.ts
│   │   │   └── events/
│   │   └── test/
│   │
│   ├── db/                       # データベース
│   │   ├── src/
│   │   │   ├── schema.ts         # Drizzle schema
│   │   │   ├── migrations/
│   │   │   └── client.ts
│   │   └── drizzle.config.ts
│   │
│   ├── llm/                      # LLM抽象化
│   │   ├── src/
│   │   │   ├── claude-code/
│   │   │   │   ├── run.ts        # CLI wrapper
│   │   │   │   └── parse.ts
│   │   │   └── prompts/
│   │   └── test/
│   │
│   ├── vcs/                      # GitHub連携
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── pr.ts
│   │   │   └── webhook.ts
│   │   └── test/
│   │
│   ├── queue/                    # ジョブキュー
│   │   ├── src/
│   │   │   ├── producer.ts
│   │   │   └── consumer.ts
│   │   └── test/
│   │
│   └── policies/                 # ポリシー定義
│       ├── default/
│       │   └── policy.json
│       └── schemas/
│           └── policy.schema.json
│
├── ops/
│   ├── docker/
│   │   └── worker.Dockerfile
│   ├── scripts/
│   │   ├── start.sh
│   │   └── reset-db.sh
│   └── runbooks/
│       ├── incident-cost.md
│       └── incident-loop.md
│
├── docs/
│   ├── architecture.md
│   ├── task-spec.md
│   ├── instructions-guide.md
│   └── security.md
│
└── templates/
    ├── requirement.md            # 要件定義テンプレート
    └── task.schema.json          # タスクJSONスキーマ
```

---

## コンポーネント詳細

### API (`apps/api`)

管理APIとWebhook受信。Honoで実装。

```typescript
// 主要エンドポイント
POST   /tasks              // タスク作成
GET    /tasks              // タスク一覧
GET    /tasks/:id          // タスク詳細
PATCH  /tasks/:id          // タスク更新
DELETE /tasks/:id          // タスク削除

GET    /runs               // 実行履歴
GET    /runs/:id           // 実行詳細
POST   /runs/:id/cancel    // 実行中止

POST   /webhook/github     // GitHub Webhook
```

### Dispatcher (`apps/dispatcher`)

タスクをWorkerに割り当てる。

```
1. queued状態のタスクを取得
2. 依存関係を確認（先行タスク完了済み？）
3. 優先度でソート
4. 空いているWorkerにリース発行
5. Worker起動
```

### Worker (`apps/worker`)

Claude Codeを実行してPRを作成する。

```
1. リポジトリをcheckout
2. 作業ブランチ作成 (agent/<id>/<task-id>)
3. Claude Code実行（instructions + task）
4. 変更をverify（lint/test）
5. コミット & プッシュ
6. PR作成
7. 結果を報告
```

### Planner (`apps/planner`)

要件からタスクを生成・分割する。

```
入力: requirement.md（人間が書く）
出力: tasks[]（DBに保存）

分割ルール:
- 1タスク = 30〜90分で完了
- テストで成功判定可能
- 依存関係を明示
- 変更範囲を限定
```

### Judge (`apps/judge`)

PRの採用/差し戻しを判定する。

```
評価要素:
1. CI結果（必須）
2. Computed Risk (機械的リスク算出)
   - diff行数 / ファイル数
   - 変更パスの機微（auth/db/core等）
   - テストの追加有無
3. LLMレビュー（定性評価）

判定結果:
- approve: 条件を満たせば自動マージ
- request_changes: 修正依頼
- needs_human: 人間レビュー必要（High Risk等）
```

---

## PR & Review Strategy

h1veは「人間によるレビュー」をボトルネックにしないよう、リスクに基づいた段階的な自動化を行います。

| カテゴリ | リスク | 自動マージ条件 | レビュー |
| :--- | :--- | :--- | :--- |
| **Critical** | High | 不可 | **人間必須** |
| **Business Logic** | Mid | 条件付き (CI+LLM) | 人間推奨 |
| **Internal / Fix** | Low | CI Green + Small Diff | AIのみ |
| **Docs / Meta** | Safe | CI Green | 完全自動 |

---

## データモデル

### tasks

```sql
CREATE TABLE tasks (
  id            UUID PRIMARY KEY,
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,           -- 完了条件
  context       JSONB,                   -- 関連情報
  allowed_paths TEXT[],                  -- 変更許可パス
  commands      TEXT[],                  -- 検証コマンド
  priority      INTEGER DEFAULT 0,
  risk_level    TEXT DEFAULT 'low',      -- low/medium/high
  status        TEXT DEFAULT 'queued',   -- queued/running/done/failed/blocked
  dependencies  UUID[],                  -- 先行タスク
  timebox_min   INTEGER DEFAULT 60,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### runs

```sql
CREATE TABLE runs (
  id            UUID PRIMARY KEY,
  task_id       UUID REFERENCES tasks(id),
  agent_id      TEXT NOT NULL,
  status        TEXT DEFAULT 'running',  -- running/success/failed/cancelled
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  cost_tokens   INTEGER,
  log_path      TEXT,
  error_message TEXT
);
```

### artifacts

```sql
CREATE TABLE artifacts (
  id            UUID PRIMARY KEY,
  run_id        UUID REFERENCES runs(id),
  type          TEXT NOT NULL,           -- pr/commit/ci_result
  ref           TEXT,                    -- PR番号、コミットSHA等
  url           TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### leases

```sql
CREATE TABLE leases (
  id            UUID PRIMARY KEY,
  task_id       UUID REFERENCES tasks(id) UNIQUE,
  agent_id      TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

## タスク仕様

### Task JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["title", "goal", "commands"],
  "properties": {
    "title": {
      "type": "string",
      "description": "タスクの簡潔な説明"
    },
    "goal": {
      "type": "string",
      "description": "完了条件（機械判定可能な形式）"
    },
    "context": {
      "type": "object",
      "properties": {
        "files": { "type": "array", "items": { "type": "string" } },
        "specs": { "type": "string" },
        "notes": { "type": "string" }
      }
    },
    "allowed_paths": {
      "type": "array",
      "items": { "type": "string" },
      "description": "変更を許可するパス（glob）"
    },
    "commands": {
      "type": "array",
      "items": { "type": "string" },
      "description": "検証コマンド（全て成功で完了）"
    },
    "priority": {
      "type": "integer",
      "default": 0
    },
    "risk_level": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "default": "low"
    },
    "dependencies": {
      "type": "array",
      "items": { "type": "string" },
      "description": "先行タスクのID"
    },
    "timebox_minutes": {
      "type": "integer",
      "default": 60,
      "description": "想定作業時間（分）"
    }
  }
}
```

### タスク例

```json
{
  "title": "UserServiceにemailバリデーション追加",
  "goal": "packages/core/src/services/user.test.ts の新規テストが全て通過",
  "context": {
    "files": [
      "packages/core/src/services/user.ts",
      "packages/core/src/validators/email.ts"
    ],
    "specs": "RFC 5322準拠のメールアドレス検証"
  },
  "allowed_paths": [
    "packages/core/src/services/user.ts",
    "packages/core/src/services/user.test.ts",
    "packages/core/src/validators/**"
  ],
  "commands": [
    "pnpm test --filter=@h1ve/core -- user.test.ts"
  ],
  "priority": 10,
  "risk_level": "low",
  "timebox_minutes": 45
}
```

---

## 要件定義テンプレート

人間が書く唯一の入力。Plannerがこれを読んでタスクを生成する。

```markdown
# Goal
[何を達成したいか]

# Background
[なぜ必要か、現状の課題]

# Constraints
- [守るべき制約1]
- [守るべき制約2]

# Acceptance Criteria
- [ ] [完了条件1（テスト可能な形式）]
- [ ] [完了条件2]

# Scope
## In Scope
- [やること]

## Out of Scope
- [やらないこと]

# Allowed Paths
- [変更を許可するディレクトリ/ファイル]

# Risk Assessment
- [想定されるリスクと対策]

# Notes
[その他の補足情報]
```

---

## 実装フェーズ

詳細なタスク一覧と進捗は [docs/task.md](./docs/task.md) を参照。

| Phase | 内容 | 進捗 |
|-------|------|------|
| Phase 1 | 土台（モノレポ、DB、API） | 82% |
| Phase 2 | Worker実行（Claude Code + PR作成） | 58% |
| Phase 3 | Dispatcher（並列実行） | 22% |
| Phase 4 | Planner（タスク自動生成） | 29% |
| Phase 5 | Judge（PR自動判定） | 25% |
| Phase 6 | Cycle Manager（長時間運用） | 0% |
| Phase 7 | 運用（ダッシュボード等） | 0% |

---

## セットアップ

### 前提条件

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose
- PostgreSQL 16+
- Redis 7+
- Claude Code CLI

### インストール

```bash
# リポジトリクローン
git clone https://github.com/your-org/h1ve.git
cd h1ve

# 依存関係インストール
pnpm install

# 環境変数設定
cp .env.example .env
# .env を編集

# データベース起動
docker compose up -d postgres redis

# マイグレーション実行
pnpm db:migrate

# 開発サーバ起動
pnpm dev
```

### 環境変数

```env
# Database
DATABASE_URL=postgresql://h1ve:h1ve@localhost:5432/h1ve

# Redis
REDIS_URL=redis://localhost:6379

# GitHub
GITHUB_TOKEN=ghp_xxxx
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Claude
ANTHROPIC_API_KEY=sk-ant-xxxx

# Security
API_SECRET=your-api-secret
```

---

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| 言語 | TypeScript |
| ランタイム | Node.js 20 |
| パッケージ管理 | pnpm |
| ビルド | turbo |
| API | Hono |
| DB | PostgreSQL + Drizzle |
| Queue | Redis + BullMQ |
| テスト | Vitest |
| E2E | Playwright |
| コンテナ | Docker |
| VCS | GitHub |
| LLM | Claude Code |

---

## セキュリティ

### 実行隔離

- Workerは必ずDockerコンテナ内で実行
- ネットワークアクセスはAllowlist方式で制限
- 秘密情報は必要なもののみ環境変数で渡し、他は遮断

### 変更制限

- `allowed_paths` 外への変更は物理的に拒否
- 危険コマンド（`rm -rf`, `chmod` 等）はSandboxレベルでハードブロック
- 変更行数/ファイル数に閾値を設け、超える場合は強制停止

### 監査

- 全操作をイベントログに記録（証跡管理）
- コスト（トークン消費）の異常値を検知して自動停止
- 全てのPRにエージェント名とタスクIDを明記

---

## 運用ガイド

### コスト管理

```bash
# 日次コスト確認
pnpm ops:cost-report

# 上限設定（.env）
DAILY_TOKEN_LIMIT=1000000
MAX_CONCURRENT_WORKERS=10
```

### 障害対応

| 状況 | 対応 |
|------|------|
| コスト暴騰 | `pnpm ops:pause` で全停止 |
| 無限ループ | 該当Workerを `cancelled` に |
| 誤った変更 | PRをクローズ、ブランチ削除 |

### モニタリング

```bash
# ダッシュボード起動
pnpm dashboard

# ログ確認
pnpm ops:logs --follow
```

---

## ライセンス

MIT

---

## 参考資料

- [Cursor: Scaling Long-Running Autonomous Coding](https://cursor.com/ja/blog/scaling-agents)
- [wilsonzlin/fastrender](https://github.com/wilsonzlin/fastrender) - Cursor研究で構築されたブラウザ
- [Claude Code Best Practices](https://docs.anthropic.com/claude-code)
