# 運用モード

最終更新: 2026-02-06

運用モードは3軸で決まる。

- リポジトリ運用: `REPO_MODE`
- Judge実行: `JUDGE_MODE`
- Worker起動: `LAUNCH_MODE`

## 1. REPO_MODE

### `REPO_MODE=git`

- remote repo を clone して作業
- push と PR 作成を行う
- Judge は PRベース判定が基本

必要な主設定:

- `REPO_URL`
- `BASE_BRANCH`
- `GITHUB_TOKEN`

### `REPO_MODE=local`

- `LOCAL_REPO_PATH` を基点に `git worktree` で並列作業
- push と PR は行わない
- Judge は local diff 評価を行う

必要な主設定:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. JUDGE_MODE

- `JUDGE_MODE=git`
  - 強制的にPRモード
- `JUDGE_MODE=local`
  - 強制的にlocalモード
- `JUDGE_MODE=auto` または未指定
  - `REPO_MODE` に追従

補助設定:

- `JUDGE_MERGE_ON_APPROVE` (default: true)
- `JUDGE_REQUEUE_ON_NON_APPROVE` (default: true)
- `JUDGE_LOCAL_BASE_REPO_RECOVERY=llm|stash|none`

## 3. LAUNCH_MODE

- `LAUNCH_MODE=process`
  - 常駐workerにキュー配信
  - 実運用での推奨デフォルト
- `LAUNCH_MODE=docker`
  - タスクごとにDockerコンテナ実行
  - 隔離強化が必要な環境向け

## 4. 推奨組み合わせ

- CI/PR中心運用:
  - `REPO_MODE=git`
  - `JUDGE_MODE=auto`
  - `LAUNCH_MODE=process`
- ローカル高速検証:
  - `REPO_MODE=local`
  - `JUDGE_MODE=auto`
  - `LAUNCH_MODE=process`
- 厳格隔離運用:
  - `REPO_MODE=git` または `local`
  - `LAUNCH_MODE=docker`

## 5. 重要な再試行設定

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `DISPATCH_RETRY_DELAY_MS`

上記は「止まらず並列で完走」の挙動に直結する。
