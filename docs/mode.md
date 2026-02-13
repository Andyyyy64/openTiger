# 運用モード

openTiger の挙動は、リポジトリモード / 判定モード / 実行環境 の組み合わせで制御されます。

関連:

- `docs/config.md`
- `docs/state-model.md`
- `docs/flow.md`
- `docs/operations.md`
- `docs/startup-patterns.md`
- `docs/execution-mode.md`
- `docs/agent/dispatcher.md`
- `docs/agent/judge.md`

### 共通逆引き導線（状態語彙 -> 遷移 -> 担当 -> 実装、モード設定から入る場合）

モード設定を確認したあとに停滞を追う場合は、状態語彙 -> 遷移 -> 担当 -> 実装の順で確認してください。

1. `docs/state-model.md`（状態語彙の確認）
2. `docs/flow.md`（遷移と回復経路）
3. `docs/operations.md`（API 確認手順と運用ショートカット）
4. `docs/agent/README.md`（担当 agent と実装追跡ルート）

## 1. リポジトリモード（`REPO_MODE`）

### `git`

- clone/push/PR ベースの運用
- judge は主に PR artifact を評価

必須設定:

- `REPO_URL`
- `BASE_BRANCH`
- `GITHUB_AUTH_MODE`（`gh` または `token`、既定: `gh`）
- `GITHUB_OWNER`
- `GITHUB_REPO`

補足:

- `GITHUB_AUTH_MODE=gh` の場合は GitHub CLI（`gh auth login`）で認証します。
- `GITHUB_AUTH_MODE=token` の場合は `GITHUB_TOKEN` を設定します。

### `local`

- ローカルリポジトリ + worktree ベースの運用
- remote PR 作成は不要

必須設定:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. 判定モード（`JUDGE_MODE`）

- `git`: PR review 経路を強制
- `local`: ローカル差分経路を強制
- `auto`: リポジトリモードに追従

補足:

- `JUDGE_MODE` は環境変数で決まる runtime option であり、`system_config` の DB キーではありません。

主要フラグ:

- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`

## 3. 実行環境と起動モード

ユーザー向け設定キーは `EXECUTION_ENVIRONMENT`（`system_config`）です。

内部の起動モードは次のように導出されます。

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

実行時の詳細（Docker image/network、sandbox 認証、トラブルシュート）は `docs/execution-mode.md` を参照してください。

`LAUNCH_MODE` は runtime の内部値のため、通常は直接設定する必要はありません。

### `process`（host）

- 常駐 agent が queue job を消化
- 回復速度と運用可視性を優先

### `docker`（sandbox）

- task 単位の container 分離
- 分離要件が厳しい環境で有効

## 4. スケーリングルール

- planner は API/system ロジックで 1 process に固定
- worker/tester/docser/judge の数は設定可能
- dispatcher の slot 制御は busy な実行 role（`worker/tester/docser`）のみを計数

実装責務:

- slot 制御/配布判定: `docs/agent/dispatcher.md`
- approve/rework 判定: `docs/agent/judge.md`

## 5. 想定される起動時挙動

`/system/preflight` は意図的に planner をスキップする場合があります。

典型例:

- issue backlog がある -> issue task を先に作成/継続
- open PR または `awaiting_judge` backlog がある -> judge を先行起動
- planner は backlog が解消され、かつ requirement がある場合のみ起動

## 6. リトライ / 回復制御

主要ノブ:

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`（`-1` は global retry budget 無制限）
- `DISPATCH_RETRY_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART*`

キュー/ロック回復ノブ:

- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

## 7. quota 運用設定

- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`

現在の task レベル挙動は、`blocked(quota_wait)` と cycle の cooldown requeue により収束させる設計です。
