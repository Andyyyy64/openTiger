# Sebastian-code（セバスチャン・コード）

**AI Agent Orchestration System for Autonomous Coding**

複数のAIエージェントを協調させ、要件から実装・判定・再試行までを自律運転するオーケストレーションシステム。  
設計思想は [Cursor Research: Scaling Long-Running Autonomous Coding](https://cursor.com/ja/blog/scaling-agents) をベースにしている。

---

## 思想

- 役割分離（Planner / Dispatcher / Worker / Judge / Cycle Manager）
- 機械判定可能な完了条件
- リース中心の並列制御
- 冪等性と回復性を優先した長時間運用

---

## 主要コンポーネント

- Planner
  - requirement から task を生成
- Dispatcher
  - task 割り当てと並列制御
- Worker / Tester / Docser
  - 実装、テスト、ドキュメント更新
- Judge
  - 判定と遷移制御
- Cycle Manager
  - stuck回復、再投入、メトリクス管理

---

## 最近の重要変更（2026-02-06）

- Judge冪等化
  - `runs.judged_at` / `judgement_version` を導入
- `blockReason` 導入
  - `awaiting_judge` / `needs_rework` / `needs_human`
- failed/blocked の適応リトライ
  - 失敗を `env/setup/policy/test/flaky/model` に分類
- concurrency制御の一本化
  - busy agent ベース
- verifyの非破壊化
  - verify中の `package.json` 自動編集を廃止
- deniedCommands の二重防御
  - verify前 + OpenCode実行前

---

## 環境構築

### 前提

- Node.js 20+
- pnpm 9+
- Docker / Docker Compose
- PostgreSQL
- Redis
- OpenCode CLI

### セットアップ

```bash
git clone git@github.com:Andyyyy64/SebastianCode.git
cd SebastianCode
pnpm install
cp .env.example .env
pnpm restart
```

---

## クイックスタート

1. requirement を用意
2. Planner で task 生成
3. Dispatcher/Worker/Judge/Cycle Manager を起動
4. Dashboard で `QUEUE AGE MAX` / `BLOCKED > 30M` / `RETRY EXHAUSTED` を監視

---

## ドキュメント

- `docs/README.md` (索引)
- `docs/flow.md` (状態遷移)
- `docs/mode.md` (運用モード)
- `docs/nonhumanoriented.md` (長時間運用原則)
- `docs/task.md` (実装状況)
- `docs/agent/*.md` (エージェント仕様)

---

最終更新: 2026-02-06
