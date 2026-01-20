# h1ve 実装タスク一覧

> このファイルで実装進捗を管理する。  
> 完了したタスクには `[x]` をつける。

---

## Phase 1: 土台（状態管理とAPIの基盤）

**目標**: 状態管理とAPIの基盤を作る  
**完了条件**: `pnpm test` が通り、APIでタスクのCRUDができる

### モノレポ初期化

- [x] `package.json` 作成（pnpm + turbo）
- [x] `pnpm-workspace.yaml` 作成
- [x] `turbo.json` 作成
- [x] `tsconfig.base.json` 作成
- [x] `.gitignore` 作成
- [x] `.env.example` 作成
- [x] `docker-compose.yml` 作成（Postgres + Redis）

### packages/core: ドメインモデル

- [x] `domain/task.ts` - タスク定義（Zodスキーマ）
- [x] `domain/run.ts` - 実行記録定義
- [x] `domain/artifact.ts` - 成果物定義
- [x] `domain/lease.ts` - リース定義
- [x] `domain/policy.ts` - ポリシー定義
- [x] `domain/agent.ts` - エージェント定義

### packages/db: データベース

- [x] `schema.ts` - Drizzle ORMスキーマ定義
- [x] `client.ts` - DBクライアント
- [x] `drizzle.config.ts` - Drizzle設定
- [ ] マイグレーションファイル生成（`pnpm db:generate`）
- [ ] マイグレーション実行（`pnpm db:push`）

### apps/api: 管理API

- [x] `index.ts` - Honoサーバ起動
- [x] `routes/health.ts` - ヘルスチェック
- [x] `routes/tasks.ts` - タスクCRUD
- [x] `routes/runs.ts` - 実行履歴
- [x] `routes/agents.ts` - エージェント管理
- [ ] `routes/webhook.ts` - GitHub Webhook受信
- [ ] 認証ミドルウェア
- [ ] レート制限

### packages/policies: ポリシー定義

- [x] `default/policy.json` - デフォルトポリシー
- [x] `schemas/policy.schema.json` - JSONスキーマ

### templates: テンプレート

- [x] `requirement.md` - 要件定義テンプレート
- [x] `task.schema.json` - タスクJSONスキーマ

---

## Phase 2: Worker実行（Claude Codeを使ってPRを作成）

**目標**: Claude Codeを使ってPRを作れるようにする  
**完了条件**: 固定タスクを渡すとPRが1本作成される

### packages/llm: LLM抽象化

- [x] `claude-code/run.ts` - Claude Code CLI wrapper
- [x] `claude-code/parse.ts` - 出力パーサー
- [ ] トークン使用量の計測
- [ ] リトライロジック
- [ ] タイムアウト処理の強化

### packages/vcs: GitHub連携

- [x] `client.ts` - Octokitクライアント
- [x] `pr.ts` - PR作成・マージ・コメント
- [x] `git.ts` - Git操作（clone, branch, commit, push）
- [ ] Webhook検証
- [ ] Rate Limit対応

### apps/worker: 実行エンジン

- [x] `steps/checkout.ts` - リポジトリクローン
- [x] `steps/branch.ts` - ブランチ作成
- [x] `steps/execute.ts` - Claude Code実行
- [x] `steps/verify.ts` - 変更検証（ポリシー + コマンド）
- [x] `steps/commit.ts` - コミット & プッシュ
- [x] `steps/pr.ts` - PR作成
- [x] `steps/index.ts` - ステップエクスポート
- [x] `main.ts` - Workerメインループ
- [ ] `sandbox/docker.ts` - Docker実行隔離
- [ ] リトライロジック（テスト失敗時の自己修正）
- [ ] ログ出力の構造化

### Worker用Dockerfile

- [ ] `ops/docker/worker.Dockerfile` - Worker用Dockerfile
- [ ] Git + Claude Code CLIのインストール
- [ ] セキュリティ設定（非root実行）
- [ ] ネットワーク制限

### instructions設計

- [x] `instructions/base.md` - 基本ルール
- [ ] `instructions/coding.md` - コーディング規約
- [ ] `instructions/refactor.md` - リファクタリング用
- [ ] `instructions/bugfix.md` - バグ修正用

---

## Phase 3: Dispatcher（複数Workerを並列実行）

**目標**: 複数Workerを並列実行  
**完了条件**: 10タスクを5 Workerで並列処理できる

### apps/dispatcher: タスク割当

- [x] `main.ts` - ディスパッチャーメインループ（スケルトン）
- [ ] `scheduler/lease.ts` - リース取得・解放・期限切れ処理
- [ ] `scheduler/priority.ts` - 優先度計算
- [ ] `scheduler/deps.ts` - 依存関係解決
- [ ] Worker起動（Docker or プロセス）
- [ ] ハートビート監視
- [ ] 失敗時のリトライ・再キューイング

### packages/queue: ジョブキュー

- [x] `index.ts` - BullMQ連携（キュー作成、ワーカー作成）
- [ ] ジョブの優先度制御
- [ ] 失敗ジョブの監視
- [ ] デッドレター処理

---

## Phase 4: Planner（要件からタスクを自動生成）

**目標**: 要件からタスクを自動生成  
**完了条件**: requirement.md を渡すとtasksが生成される

### apps/planner: タスク生成

- [x] `main.ts` - Plannerメインループ（スケルトン）
- [ ] `strategies/from-requirement.ts` - 要件ファイルからタスク生成
- [ ] `strategies/from-issue.ts` - GitHub Issueからタスク生成
- [ ] タスク分割ロジック（30-90分粒度）
- [ ] 依存関係の推定
- [ ] 重複タスクの検出

### instructions設計

- [x] `instructions/planning.md` - タスク分割ルール

---

## Phase 5: Judge（PRの自動判定）

**目標**: PRの自動判定  
**完了条件**: CI通過のlow-risk PRが自動マージされる

### apps/judge: 採用判定

- [x] `main.ts` - Judgeメインループ（スケルトン）
- [ ] `evaluators/ci.ts` - CI結果取得・評価
- [ ] `evaluators/policy.ts` - ポリシー違反チェック
- [ ] `evaluators/llm.ts` - LLMコードレビュー
- [ ] PRコメント投稿
- [ ] 自動マージ実行
- [ ] 差し戻し処理

### instructions設計

- [x] `instructions/review.md` - レビュー基準

---

## Phase 6: Cycle Manager（長時間運用の安定化）

**目標**: 長時間運用の安定化  
**完了条件**: 24時間連続稼働でドリフトなく動作

### Cycle Manager

- [ ] サイクル制御（時間ベース）
- [ ] サイクル制御（タスク数ベース）
- [ ] サイクル制御（失敗率ベース）
- [ ] クリーン再スタート処理
- [ ] 状態の永続化と復元

### 監査ログ

- [ ] イベントログ記録
- [ ] コスト集計
- [ ] 異常検知

---

## Phase 7: 運用（本番運用の安定化）

**目標**: 本番運用の安定化

### apps/dashboard: ダッシュボード（React + Vite + Tailwind）

**技術スタック**:
- React 19 + TypeScript
- Vite
- Tailwind CSS v4
- TanStack Query（データフェッチ）
- @h1ve/api からREST APIで取得

#### プロジェクト初期化

- [ ] Vite + React + TypeScript セットアップ
- [ ] Tailwind CSS 設定
- [ ] API クライアント設定（fetch wrapper）
- [ ] TanStack Query 設定
- [ ] ルーティング設定（React Router）

#### レイアウト・共通コンポーネント

- [ ] サイドバー（ナビゲーション）
- [ ] ヘッダー（ステータス表示）
- [ ] ローディング・エラー表示

#### タスク管理画面

- [ ] タスク一覧（フィルタ: status, priority, risk_level）
- [ ] タスク詳細表示
- [ ] タスク作成フォーム
- [ ] タスクステータス更新

#### 実行履歴画面

- [ ] Run一覧（フィルタ: status, agent）
- [ ] Run詳細（ログ表示）
- [ ] 成果物（Artifacts）一覧
- [ ] PRリンク表示

#### エージェント管理画面

- [ ] エージェント一覧（ステータス表示）
- [ ] エージェント詳細
- [ ] ハートビート監視表示

#### 統計・モニタリング画面

- [ ] タスク完了率グラフ
- [ ] コスト（トークン使用量）グラフ
- [ ] エージェント稼働状況
- [ ] 直近の失敗タスク一覧

#### リアルタイム更新

- [ ] WebSocket接続 or ポーリング
- [ ] ステータス変更の即時反映
- [ ] 通知表示（トースト）

### アラート・モニタリング

- [ ] コスト異常検知
- [ ] 失敗率異常検知
- [ ] Slack/Discord通知

### ランブック

- [ ] `ops/runbooks/incident-cost.md` - コスト暴騰時対応
- [ ] `ops/runbooks/incident-loop.md` - 無限ループ時対応
- [ ] `ops/runbooks/incident-bad-merge.md` - 誤マージ時対応

### コスト最適化

- [ ] モデル選択の最適化
- [ ] キャッシュ活用
- [ ] 並列度の動的調整

---

## 進捗サマリー

| Phase | 完了/全体 | 進捗 |
|-------|----------|------|
| Phase 1: 土台 | 18/22 | 82% |
| Phase 2: Worker実行 | 15/26 | 58% |
| Phase 3: Dispatcher | 2/9 | 22% |
| Phase 4: Planner | 2/7 | 29% |
| Phase 5: Judge | 2/8 | 25% |
| Phase 6: Cycle Manager | 0/8 | 0% |
| Phase 7: 運用 | 0/34 | 0% |
| **合計** | **39/114** | **34%** |

---

## 次にやるべきこと（優先度順）

1. **DBマイグレーション実行** - `docker compose up -d` + `pnpm db:push`
2. **Worker用Dockerfile作成** - 本番実行のためのサンドボックス
3. **Dispatcher本実装** - Worker自動起動の仕組み
4. **Planner本実装** - 要件からタスク自動生成
