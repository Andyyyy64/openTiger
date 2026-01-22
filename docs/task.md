# h1ve 実装タスク一覧

> このファイルで実装進捗を管理する。  
> 完了したタスクには `[x]` をつける。

---

## プロジェクトステータス

| フェーズ | 概要 | Implemented | Proven* | ステータス |
| :--- | :--- | :--- | :--- | :--- |
| Phase 1 | 土台（状態管理とAPIの基盤） | 100% | 90% | ✅ Done |
| Phase 2 | Worker実行（Claude Code + PR作成） | 100% | 80% | 🚀 Active |
| Phase 3 | Dispatcher（並列実行・割当） | 100% | 60% | 🚀 Active |
| Phase 4 | Planner（タスク自動生成） | 100% | 30% | 🚀 Active |
| Phase 5 | Judge（PR自動判定） | 100% | 40% | 🚀 Active |
| Phase 6 | Cycle Manager（長時間運用） | 100% | 20% | 🚀 Active |
| Phase 7 | 品質保証・Orchestration検証 | 50% | 5% | 🚧 In Progress |
| Phase 8 | 運用・可視化（Dashboard） | 5% | 0% | 🚀 Active |

`*Proven: 異常系（Rate limit/故障/再起動）、並列負荷、冪等性などが実地検証されている度合い`

---

## 🔄 軌道修正・運用強化タスク (MVP優先)

実装は完了しているが、並列運用時に「詰む」ポイントを回避するための強化項目。

### 1. 進捗表示の厳格化
- [ ] `docs/task.md` の進捗表を Implemented/Proven の2軸に管理
- [ ] 各フェーズの「Proven」条件（検証シナリオ）の定義

### 2. Run Lifecycle & 冪等性の強化
- [ ] `Soft Cancel` (安全な停止) と `Hard Kill` (強制終了) の実装
- [x] 異常終了したタスクの再キューイング条件の明文化
- [x] 同一タスクの再試行時にPR重複やブランチ衝突を防ぐ冪等性ロジック

### 3. コンフリクト制御 (Target Area)
- [x] `packages/core/domain/task.ts` に `target_area` と `touches` フィールドを追加
- [x] Dispatcherによる `target_area` ごとの並列度制限の実装（設定可能に）

### 4. Computed Risk による自動判定
- [x] Judgeに `computed_risk` 算出ロジックを実装（diffサイズ、パス、テスト有無ベース）
- [x] `risk_level` (自己申告) を `computed_risk` で上書きする仕組み
- [ ] 自動マージ可能な条件の厳格化と実装

### 5. セキュリティ・実行隔離の徹底
- [x] Workerコンテナに渡す環境変数の `Allowlist` 方式化
- [x] 実行禁止コマンドの実行側（Sandbox）でのハードブロック

---

## 🔮 Future Tasks (Post-MVP)

- [ ] **Requirement Interview**: 人間との対話による要件定義支援モード
- [ ] **API Fallback Strategy**: Maxプラン上限時の自動API切り替えロジック
- [ ] **Cost-Aware Planning**: 予算に応じたタスク優先度・モデルの動的変更

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
- [x] マイグレーション実行（`pnpm db:push`）

### apps/api: 管理API

- [x] `index.ts` - Honoサーバ起動
- [x] `routes/health.ts` - ヘルスチェック
- [x] `routes/tasks.ts` - タスクCRUD
- [x] `routes/runs.ts` - 実行履歴
- [x] `routes/agents.ts` - エージェント管理
- [x] `routes/webhook.ts` - GitHub Webhook受信
- [x] 認証ミドルウェア
- [x] レート制限

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
- [x] トークン使用量の計測
- [x] リトライロジック
- [x] タイムアウト処理の強化

### packages/vcs: GitHub連携

- [x] `client.ts` - Octokitクライアント
- [x] `pr.ts` - PR作成・マージ・コメント
- [x] `git.ts` - Git操作（clone, branch, commit, push）
- [x] Webhook検証
- [x] Rate Limit対応

### apps/worker: 実行エンジン

- [x] `steps/checkout.ts` - リポジトリクローン
- [x] `steps/branch.ts` - ブランチ作成
- [x] `steps/execute.ts` - Claude Code実行
- [x] `steps/verify.ts` - 変更検証（ポリシー + コマンド）
- [x] `steps/commit.ts` - コミット & プッシュ
- [x] `steps/pr.ts` - PR作成
- [x] `steps/index.ts` - ステップエクスポート
- [x] `main.ts` - Workerメインループ
- [x] `sandbox/docker.ts` - Docker実行隔離
- [x] リトライロジック（テスト失敗時の自己修正）
- [x] ログ出力の構造化

### Worker用Dockerfile

- [x] `ops/docker/worker.Dockerfile` - Worker用Dockerfile
- [x] Git + Claude Code CLIのインストール
- [x] セキュリティ設定（非root実行）
- [x] ネットワーク制限

### instructions設計

- [x] `instructions/base.md` - 基本ルール
- [x] `instructions/coding.md` - コーディング規約
- [x] `instructions/refactor.md` - リファクタリング用
- [x] `instructions/bugfix.md` - バグ修正用

---

## Phase 3: Dispatcher（複数Workerを並列実行）

**目標**: 複数Workerを並列実行  
**完了条件**: 10タスクを5 Workerで並列処理できる

### apps/dispatcher: タスク割当

- [x] `main.ts` - ディスパッチャーメインループ（本実装）
- [x] `scheduler/lease.ts` - リース取得・解放・期限切れ処理
- [x] `scheduler/priority.ts` - 優先度計算・依存関係解決
- [x] `scheduler/worker-launcher.ts` - Worker起動（Docker / プロセス）
- [x] `scheduler/heartbeat.ts` - ハートビート監視
- [x] `scheduler/index.ts` - モジュールエクスポート
- [x] 失敗時のリトライ・再キューイング

### packages/queue: ジョブキュー

- [x] `index.ts` - BullMQ連携（キュー作成、ワーカー作成）
- [x] ジョブの優先度制御
- [x] 失敗ジョブの監視
- [x] デッドレター処理

---

## Phase 4: Planner（要件からタスクを自動生成）

**目標**: 要件からタスクを自動生成  
**完了条件**: requirement.md を渡すとtasksが生成される

### apps/planner: タスク生成

- [x] `main.ts` - Plannerメインループ（本実装）
- [x] `parser.ts` - 要件ファイルのパーサー
- [x] `strategies/from-requirement.ts` - 要件ファイルからタスク生成
- [x] `strategies/from-issue.ts` - GitHub Issueからタスク生成
- [x] `strategies/index.ts` - ストラテジーエクスポート
- [x] タスク分割ロジック（30-90分粒度）
- [x] 依存関係の推定（インデックス→ID変換）
- [x] 重複タスクの検出

### instructions設計

- [x] `instructions/planning.md` - タスク分割ルール

---

## Phase 5: Judge（PRの自動判定）

**目標**: PRの自動判定  
**完了条件**: CI通過のlow-risk PRが自動マージされる

### apps/judge: 採用判定

- [x] `main.ts` - Judgeメインループ（本実装）
- [x] `evaluators/ci.ts` - CI結果取得・評価
- [x] `evaluators/policy.ts` - ポリシー違反チェック
- [x] `evaluators/llm.ts` - LLMコードレビュー
- [x] `evaluators/index.ts` - 評価器エクスポート
- [x] `pr-reviewer.ts` - PRコメント・判定・自動マージ
- [x] PRコメント投稿
- [x] 自動マージ実行
- [x] 差し戻し処理

### instructions設計

- [x] `instructions/review.md` - レビュー基準

---

## Phase 6: Cycle Manager（長時間運用の安定化）

**目標**: 長時間運用の安定化  
**完了条件**: 24時間連続稼働でドリフトなく動作

### Cycle Manager

- [x] サイクル制御（時間ベース）
- [x] サイクル制御（タスク数ベース）
- [x] サイクル制御（失敗率ベース）
- [x] クリーン再スタート処理
- [x] 状態の永続化と復元

### 監査ログ

- [x] イベントログ記録
- [x] コスト集計
- [x] 異常検知

---

## Phase 7: テスト・CI/CD（品質保証基盤）

**目標**: 継続的な品質保証と自動デプロイの基盤を構築  
**完了条件**: CIですべてのテストがパスし、カバレッジが可視化される

### 単体テスト (Vitest)

- [x] `packages/core` のドメインモデルテスト
- [x] `packages/llm` のパース・リトライロジックテスト
- [x] `packages/vcs` のGit操作・Webhook検証テスト
- [ ] `packages/queue` のジョブ管理テスト

> **Note**: 単体テストは現状で十分。外部連携コード（Claude Code CLI、Git、GitHub API）の  
> カバレッジ100%を目指すより、結合テストに注力する方が価値が高い。  
> - `packages/core`: 97% (ドメインモデルは100%)  
> - `packages/llm`: parse.ts 100%、run.ts は外部プロセス呼び出しのためモック不要  
> - `packages/vcs`: webhook.ts 100%、git/pr/client は結合テストで検証

### 結合テスト [優先度: 中]

- [ ] APIエンドポイントの統合テスト
- [ ] Workerのステップ実行フローテスト
- [ ] Planner -> Dispatcher -> Worker の連鎖テスト

### CI/CD (GitHub Actions)

- [x] PR作成時の自動チェック（Lint, Typecheck, Test）
- [x] カバレッジレポートの自動生成
- [ ] Dockerイメージの自動ビルド・プッシュ

---

## Phase 8: 運用（ダッシュボード）

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

| Phase | 完了/全体 | Implemented | Proven |
|-------|----------|-------------|--------|
| Phase 1: 土台 | 22/22 | 100% | 90% |
| Phase 2: Worker実行 | 26/26 | 100% | 80% |
| Phase 3: Dispatcher | 11/11 | 100% | 60% |
| Phase 4: Planner | 9/9 | 100% | 30% |
| Phase 5: Judge | 10/10 | 100% | 40% |
| Phase 6: Cycle Manager | 8/8 | 100% | 20% |
| Phase 7: テスト・CI/CD | 5/10 | 50% | 5% |
| Phase 8: 運用 | 0/34 | 5% | 0% |
| **合計** | **91/130** | **70%** | **40%** |

---

## 次にやるべきこと（優先度順）

1. **ダッシュボードの初期化** - React 19 + Vite + Tailwind v4 のセットアップ
2. **運用強化タスクの残り** - Soft Cancel / Hard Kill の実装
3. **E2E統合テスト (Proven向上)** - 全体フロー（Planner -> PR -> Merge）の連続成功検証
