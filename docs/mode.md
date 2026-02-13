# 運用モード（Operating Modes）

openTiger の挙動は、repository mode / judge mode / execution environment の組み合わせで制御されます。

関連:

- `docs/config.md`
- `docs/startup-patterns.md`
- `docs/execution-mode.md`
- `docs/agent/dispatcher.md`
- `docs/agent/judge.md`

## 1. Repository Mode（`REPO_MODE`）

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

- ローカル repository + worktree ベースの運用
- remote PR 作成は不要

必須設定:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. Judge Mode（`JUDGE_MODE`）

- `git`: PR review 経路を強制
- `local`: local diff 経路を強制
- `auto`: repository mode に追従

補足:

- `JUDGE_MODE` は env 駆動（runtime option）であり、`system_config` の DB キーではありません。

主要フラグ:

- `JUDGE_MERGE_ON_APPROVE`
- `JUDGE_REQUEUE_ON_NON_APPROVE`

## 3. Execution Environment と Launch Mode

ユーザー向け設定キーは `EXECUTION_ENVIRONMENT`（`system_config`）です。

内部 launch mode は次のように導出されます。

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

runtime 詳細（Docker image/network、sandbox 認証、トラブルシュート）は `docs/execution-mode.md` を参照してください。

`LAUNCH_MODE` は runtime 内部値のため、通常は直接設定する必要はありません。

### `process`（host）

- 常駐 agent が queue job を消化
- 回復速度と運用可視性を優先

### `docker`（sandbox）

- task 単位の container 分離
- 分離要件が厳しい環境で有効

## 4. Scaling Rules

- planner は API/system ロジックで 1 process にハード制限
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

## 6. Retry / Recovery Controls

主要ノブ:

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`（`-1` は global retry budget 無制限）
- `DISPATCH_RETRY_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART*`

queue/lock 回復ノブ:

- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

## 7. Quota Operation Settings

- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`

現在の task レベル挙動は、`blocked(quota_wait)` + cycle cooldown requeue により収束させる設計です。
