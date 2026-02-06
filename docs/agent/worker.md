# Worker Agent

最終更新: 2026-02-06

## 1. 役割

task を実装し、検証を通して成果物を生成する。

`AGENT_ROLE` により実体は次に分かれる。

- `worker`
- `tester`
- `docser`

## 2. 実行フロー

1. run レコード作成
2. checkout / branch 準備
3. OpenCode 実行
4. verify 実行
5. commit/push or local commit
6. PR作成（git mode）
7. run/task/artifact 更新

## 3. 重要仕様

- 同一task重複実行を lock で防止
- run成功時は task を `blocked(awaiting_judge)` へ遷移
- run失敗時は task を `failed`
- `costTokens` は OpenCode token usage を保存
- retry時は過去失敗のヒントをプロンプトに注入

## 4. セーフティ

- denyコマンドは OpenCode 実行前に拒否
- verify 実行前にも deny 判定
- verify は非破壊（repo状態を書き換えない）

## 5. 主な設定

- `AGENT_ID`
- `AGENT_ROLE`
- `WORKER_MODEL` / `TESTER_MODEL` / `DOCSER_MODEL`
- `WORKER_INSTRUCTIONS_PATH` / `TESTER_INSTRUCTIONS_PATH` / `DOCSER_INSTRUCTIONS_PATH`
- `WORKSPACE_PATH`
- `REPO_MODE`, `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `SEBASTIAN_TASK_LOCK_DIR`

## 6. 失敗時

- `runs.errorMessage` に原因を保存
- task は `failed` に遷移
- Cycle Manager の分類ベース再試行へ委譲
