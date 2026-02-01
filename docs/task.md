# h1ve 実装タスク一覧

> このファイルで実装進捗を管理する。  
> 完了したタスクには `[x]` をつける。

---

## プロジェクトステータス

| フェーズ | 概要 | Implemented | Proven* | ステータス |
| :--- | :--- | :--- | :--- | :--- |
| Phase 1 | 土台（状態管理とAPIの基盤） | 100% | 90% | ✅ Done |
| Phase 2 | Worker実行（OpenCode + PR作成） | 100% | 80% | 🚀 Active |
| Phase 3 | Dispatcher（並列実行・割当） | 100% | 60% | 🚀 Active |
| Phase 4 | Planner（タスク自動生成） | 100% | 30% | 🚀 Active |
| Phase 5 | Judge（PR自動判定） | 100% | 40% | 🚀 Active |
| Phase 6 | Cycle Manager（長時間運用） | 100% | 20% | 🚀 Active |
| Phase 7 | 品質保証・Orchestration検証 | 50% | 5% | 🚧 In Progress |
| Phase 8 | 運用・可視化（Dashboard） | 15% | 0% | 🚀 Active |

`*Proven: 異常系（Rate limit/故障/再起動）、並列負荷、冪等性などが実地検証されている度合い`

---

## 🔄 軌道修正・運用強化タスク (MVP優先)

実装は完了しているが、並列運用時に「詰む」ポイントを回避するための強化項目。

### 1. 進捗表示の厳格化

- [ ] `docs/task.md` の進捗表を Implemented/Proven の2軸に管理
- [ ] 各フェーズの「Proven」条件（検証シナリオ）の定義

### 1.5. 反復プランニングループの明確化

- [ ] Plan → Execute → Inspect → Replan のループ設計を明文化
- [ ] 全Worker完了後のコードベース点検を複数回行う運用手順の整備

### 2. Run Lifecycle & 冪等性の強化

- [ ] `Soft Cancel` (安全な停止) と `Hard Kill` (強制終了) の実装
- [x] 異常終了したタスクの再キューイング条件の明文化
- [x] 同一タスクの再試行時にPR重複やブランチ衝突を防ぐ冪等性ロジック
- [ ] Judgeが `request_changes` / `needs_human` を返した場合にタスクが停滞しない戻し処理（blocked解除・再実行方針の確立）
- [ ] `failed` / `blocked` の再投入（再試行・分割・スキップ）の自動ポリシーを実装（無限運用で止まらないため）

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
- [ ] `LaunchMode=process` でも同等の制約が効くようにする（もしくはデフォルトを `docker` に寄せる）
- [ ] OpenCode/検証コマンドを「常に」サンドボックス経由で実行する（経路の一元化）
- [ ] Worker Dockerイメージ名の統一（`h1ve/worker:latest` と `h1ve-worker:latest` の混在解消）

### 6. 役割別モデル構成の標準化

- [ ] Planner/JudgeはPro、WorkerはFlashの運用ルールを明文化

### 7. ドキュメントの作成/自動更新

無限運用では「コードは進むがドキュメントが腐る」が起きやすい。  
ドキュメント更新をタスクとして扱い、変更検知と自動更新の経路を用意する。

- [ ] ドキュメント更新専用のエージェント（docser）を用意し、`docs/**` と `ops/runbooks/**` を主な許可範囲にする
- [ ] 変更差分からドキュメント更新が必要かを判定するルール（例: public API変更、env追加、運用フロー変更）
- [ ] ドキュメント更新タスクの自動生成（PR差分/イベントログを入力としてPlannerが生成）
- [ ] `docs/task.md` の進捗サマリー（完了/全体, Implemented/Proven）を自動更新できる仕組み（機械集計 + 書き戻し）
- [ ] `docs/architecture.md` / `docs/security.md` / `docs/instructions-guide.md` の自動更新方針を定義（何を自動、何を手動で残すか）
- [ ] doc更新が失敗した場合の戻し（docserが直せないときに再分割/差分縮小へ落とす）

### 8. tester（テスト専用エージェント）の導入

無限運用では「テストがない/薄い」「フレークで止まる」「E2Eが重くて回らない」が発生しやすい。  
testerはテストの作成・実行・結果要約・フレーク対処を担当し、Workerは実装完遂に集中させる。

- [x] testerエージェントを導入し、テスト関連タスクをroleでルーティングする
- [ ] testerの許可パス指針を明文化（例: `**/*.test.ts`, `apps/**/test/**`, `packages/**/test/**`, `playwright/**`）
- [ ] Vitestによるunit/integration（結合）テストの方針を明文化（どこまでをunit、どこからをintegrationとするか）
- [ ] PlaywrightによるE2E（UI操作含む）テストの方針を明文化（staging前提/ローカル前提、seed、待機戦略、スクショ差分）
- [ ] テスト失敗時の一次切り分け（テスト不備/実装バグ/環境要因/フレーク）を自動化し、次アクション（修正タスク/リトライ/隔離）へ繋ぐ
- [ ] フレーク検知と自動リトライ（一定回数で「不安定」として隔離し、別タスクに落とす）
- [ ] 変更差分からテスト実行範囲を推定（高速化のため: unitのみ / integration追加 / E2E追加）
- [ ] Worker → Tester → Judge の標準フローを固定化し、タスク生成時に依存関係を自動付与
- [ ] E2E結果のアーティファクト保存（trace/video/screenshot）と `runs/artifacts` への紐付け
- [ ] testerが生成したテスト追加PRをJudgeに渡す運用（「実装PRに追従」「先にテストPRを通す」などの標準化）

### テスト実行の運用ルール

- 検証コマンドは自己完結にする（外部API/DBが必要なら起動・停止を含めるかテスト側でモックする）
- テストが生成する成果物は `allowed_paths` に含める（例: `apps/web/test-results/**`, `apps/web/playwright-report/**`, `coverage/**`）
- E2Eの検証は専用ポートで起動し、既存の開発サーバに依存しない構成にする
- `vitest` はwatchで常駐するため、自動検証では `vitest run` か `CI=1` を使う
- Playwrightの`webServer`は固定ポートを待つため、`VITE_PORT`や`PLAYWRIGHT_BASE_URL`を揃えて起動する

### 9. repo mode（git/local切替）の導入

git運用を維持しつつ、ローカルリポジトリでも同じ品質ゲートを回せるようにする。  
local modeでも差分/テスト/判定の流れを維持し、PRの有無だけを切替える。

- [ ] `REPO_MODE=git|local` の切替を導入（未指定はgit）
- [ ] local mode用に `LOCAL_REPO_PATH` / `LOCAL_WORKTREE_ROOT` を追加
- [ ] local modeは `git worktree` で作業領域を分離（並列安全）
- [x] local modeのベースリポジトリをstash/LLM判定で自動復旧する
- [ ] Workerのcheckout/commit/pr処理をmodeで分岐（localはpush/PRなし）
- [ ] Judgeにlocalモード判定（PRなしでdiffとテスト結果を評価）
- [ ] worktreeの自動クリーンアップ（成功/失敗/サイクル終了時）
- [x] READMEにlocal modeの前提と運用手順を追記

### 10. checker（コードベース点検エージェント）の導入

コードベースを詳細に探索し、バグ・矛盾・不整合を検知して修正タスクを自動生成する。  
Plannerの差分点検とは別系統で、実装品質の継続的改善を担う。

- [ ] checker/fixerエージェントを導入し、`apps/**` と `packages/**` を主な許可範囲にする
- [ ] ルールベース検出（未使用import、死んだコード、型不整合、TODOの放置など）を整理
- [ ] LLMによる探索レビューで「仕様逸脱/矛盾/影響範囲」を抽出する手順を定義
- [ ] 検出結果を「修正タスク」に変換し、Plannerに渡すフローを実装
- [ ] 重大度（high/medium/low）で優先度を自動調整する仕組みを追加
- [ ] 誤検出率を下げるためのフィルタ（差分重要度、直近変更、所有領域）を追加

---

## 🔮 Future Tasks (Post-MVP)

- [ ] **Requirement Interview**: 人間との対話による要件定義支援モード
- [ ] Requirement Interviewの会話ログ永続化（requirements / sessions のデータモデル追加）
- [ ] Requirementの版管理（差分・履歴・確定/編集中ステータス）
- [ ] Requirement確定後にPlannerへ引き渡すワークフロー（API/UI/CLI）
- [ ] docserの運用ルール整備（コード変更PRに同梱するか、別PRで追従するかの標準化）
- [ ] testerの運用ルール整備（E2Eを常時回す/条件付きで回す、失敗時の扱い、コスト上限）
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
- [ ] `routes/health.ts` にDB接続確認を追加
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

## Phase 2: Worker実行（OpenCodeを使ってPRを作成）

**目標**: OpenCodeを使ってPRを作れるようにする  
**完了条件**: 固定タスクを渡すとPRが1本作成される

### packages/llm: LLM抽象化

- [x] `claude-code/run.ts` - Claude Code CLI wrapper
- [x] `claude-code/parse.ts` - 出力パーサー
- [x] OpenCodeのトークン使用量抽出（stdoutから解析）
- [x] リトライロジック
- [x] タイムアウト処理の強化
- [ ] OpenCodeのtokenUsageを `runs.costTokens` に正しく反映（durationMsの代用を廃止）

### packages/vcs: GitHub連携

- [x] `client.ts` - Octokitクライアント
- [x] `pr.ts` - PR作成・マージ・コメント
- [x] `git.ts` - Git操作（clone, branch, commit, push）
- [x] Webhook検証
- [x] Rate Limit対応

### apps/worker: 実行エンジン

- [x] `steps/checkout.ts` - リポジトリクローン
- [x] `steps/branch.ts` - ブランチ作成
- [x] `steps/execute.ts` - OpenCode実行
- [x] `steps/verify.ts` - 変更検証（ポリシー + コマンド）
- [x] `steps/commit.ts` - コミット & プッシュ
- [x] `steps/pr.ts` - PR作成
- [x] `steps/index.ts` - ステップエクスポート
- [x] `main.ts` - Workerメインループ
- [x] `sandbox/docker.ts` - Docker実行隔離
- [x] リトライロジック（テスト失敗時の自己修正）
- [x] ログ出力の構造化
- [ ] `verify.ts` のコマンド実行に `policy.deniedCommands` を反映（禁止コマンドを二重で防ぐ）
- [ ] Workerがジョブ受領/開始/終了をイベントとして記録（Dispatcherが進捗を検知できるようにする）

### Worker用Dockerfile

- [x] `ops/docker/worker.Dockerfile` - Worker用Dockerfile
- [x] Git + OpenCode CLIのインストール
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
- [ ] enqueue後に「Workerが受領した」ことをDBで確認する（受領できない場合の自動復旧）
- [ ] 常駐Workerが存在しない/死んでいる場合に、`running` が積み上がらないガードを追加

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
- [ ] `request_changes` の場合に自動で「修正タスク」を生成して再投入（同一PRを更新するか、修正用PRを別にするかを方針化）
- [ ] `needs_human` を「人間待ち」で詰まらせない（追加分割・追加検証・リスク縮小に自動で落とす）
- [ ] PR判定結果を次のPlanner入力（再計画）へ機械的に反映する（失敗理由→次タスク生成）

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
- [ ] コスト集計（OpenCodeトークンを正として集計できる状態にする）
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

> **Note**: 単体テストは現状で十分。外部連携コード（OpenCode CLI、Git、GitHub API）の  
> カバレッジ100%を目指すより、結合テストに注力する方が価値が高い。  
>
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

- [x] Vite + React + TypeScript セットアップ
- [x] Tailwind CSS 設定
- [ ] API クライアント設定（fetch wrapper）
- [ ] TanStack Query 設定
- [ ] ルーティング設定（React Router）

#### レイアウト・共通コンポーネント

- [x] サイドバー（ナビゲーション）
- [x] ヘッダー（ステータス表示）
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

1. **Judge後の停滞解消** - request_changes/needs_human を自動で次のタスクへ繋ぐ（無限運用で止まらないため）
2. **実行隔離の実効性** - OpenCode/検証コマンドを常にサンドボックス経由に統一
3. **コスト/トークンの正確化** - tokenUsageをDBへ反映し、cycle-managerのコスト集計を成立させる
4. **E2E統合テスト (Proven向上)** - 全体フロー（Plan -> Execute -> Judge -> Replan）の連続成功検証
