# Sebastian-code（セバスチャン・コード）

**AI Agent Orchestration System for Autonomous Coding**

数十のAIエージェントを協調させ、自律的にコードを積み上げるオーケストレーションシステム。  
[Cursor Research: Scaling Long-Running Autonomous Coding](https://cursor.com/ja/blog/scaling-agents) の設計思想を、実運用可能な形で実装する。

---

## 思想

- 役割分離を徹底し、Planner/Judgeが統制する
- 成功条件は機械的に判定できる形に限定する
- ロックではなくリースで回収可能な並列制御を行う
- 定期的なクリーン再スタートでドリフトを抑える

---

## 環境構築

### 前提条件

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose
- PostgreSQL 16+
- Redis 7+
- OpenCode CLI

### インストール

```bash
# リポジトリクローン
git clone git@github.com:Andyyyy64/SebastianCode.git
cd SebastianCode

# 依存関係インストール
pnpm install

# 環境変数設定
cp .env.example .env
# .env を編集

# 起動（初回もこれでOK）
pnpm restart
```

`pnpm restart` はコンテナ再起動とDB初期化を含むため、既存データを保持したい場合は注意する。テスト用だからそのうち起動もダッシュボードに以降なりしたい todo

---

## 使い方

### 1. 要件を用意する

- `templates/requirement.md` をベースに要件を作成する
- 生成した要件ファイルを `docs/requirement.md` などに保存する

### 2. タスクを生成する

```bash
pnpm --filter @sebastian-code/planner start docs/requirement.md
```

### 3. 実行・判定を回す

- Dispatcher/Worker/Judge を起動し、タスクの処理と判定を継続的に回す
- 詳細な動作フローは `docs/flow.md` を参照

---

## ドキュメント

- 全体索引: `docs/README.md`
- 動作フロー: `docs/flow.md`
- 運用モード: `docs/mode.md`
- 非人間運用の思想: `docs/nonhumanoriented.md`
- エージェント: `docs/agent/planner.md`
- エージェント: `docs/agent/worker.md`
- エージェント: `docs/agent/tester.md`
- エージェント: `docs/agent/judge.md`
- 実装タスク一覧: `docs/task.md`

---

最終更新: 2026/2/3
