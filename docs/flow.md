# 動作フロー（最新版）

最終更新: 2026-02-06

## 1. 全体ループ

1. Start preflight が backlog を確認する
   - GitHub open Issue / open PR
   - ローカル `tasks`（queued/running/failed/blocked）
2. preflight が open Issue を task として直接投入する（必要時）
3. 要件テキストがあり、Issue backlog がない場合のみ Planner が task を生成する
4. Dispatcher が `queued` task を選択し、lease を取得して worker に割り当てる
5. Worker/Tester/Docser が実装・検証を実行する
6. 成功時は task を `blocked(awaiting_judge)` に遷移し、Judge を待つ
7. Judge が run を判定し、`done` / `queued` / `blocked` に遷移させる
8. Cycle Manager が stuck 回復・failed/blocked 再投入・メトリクス更新を行う
9. すべての task が終わるか、停止条件を満たすまで継続する

## 1.1 Start preflight の起動判定

- Issue backlog がある:
  - Planner は起動せず、Issue 由来 task の実行を優先
  - Dispatcher/Worker 系を起動
- PR backlog がある:
  - Judge を起動
- backlog がなく requirement のみある:
  - Planner 起動で通常計画フローへ

## 2. Task ステータス遷移

- `queued`
  - 実行待ち
- `running`
  - lease取得後に Dispatcher が遷移
- `blocked`
  - Judge待ちまたは再作業待ち
  - `blockReason`:
    - `awaiting_judge`
    - `needs_rework`
    - `needs_human`
- `failed`
  - Worker実行失敗
- `done`
  - Judge承認済みで完了
- `cancelled`
  - timeout等の中断

代表遷移:

- `queued -> running`
- `running -> blocked(awaiting_judge)`
- `blocked(awaiting_judge) -> done | queued | blocked(needs_*)`
- `failed -> queued | blocked`
- `blocked(needs_rework) -> failed + new rework task(queued)`

## 3. Run ライフサイクル

- Worker開始時に `runs` へ `running` を作成
- 成功時は `success` と `costTokens` を保存
- 失敗時は `failed` と `errorMessage` を保存
- Judge は `runs.judgedAt IS NULL` の成功runのみ対象
- Judge処理時に原子的claim:
  - `judgedAt = now`
  - `judgementVersion = judgementVersion + 1`

これにより同一runの再レビューを防止する。

## 4. Dispatcher の並列制御

- 依存関係が未解決の task は実行しない
- `targetArea` が衝突する task は同時実行しない
- 同時実行枠は `maxConcurrentWorkers - busyAgentCount`
  - process/queue モードに関係なく上限が効く

## 5. Judge 判定後の挙動

- `approve + merge成功`:
  - task を `done`
- `request_changes` / `needs_human`:
  - 既定では `queued` に戻して再実行
  - requeue無効時は `blocked(needs_rework|needs_human)` を維持
- `approve だが merge失敗`:
  - 停滞防止のため `queued` に戻す

補足:

- task に `context.issue.number` がある場合、Worker の PR本文に `Closes #<issue>` を付与する
- これにより GitHub 上で task 実行結果と Issue の紐づけを自動化する

## 6. 回復処理

Cycle Manager が定期的に以下を実施:

- timeout run の `cancelled` 化
- orphan `running` task の `queued` 復帰
- failed task の分類ベース再試行
- blocked task の reason ベース処理
  - `awaiting_judge`: judge待ちrunがなければ再投入
  - `needs_rework`: 分割タスク生成
  - `needs_human`: 隔離（自動再実行しない）

## 7. 失敗分類（adaptive retry）

失敗は次カテゴリに分類して再試行戦略を変える。

- `env`
- `setup`
- `policy`
- `test`
- `flaky`
- `model`

同じ原因の盲目的再実行を防ぎ、上限到達時は `blocked` へ遷移する。

## 8. SLO と観測項目

- SLO1: `queued -> running` 5分以内
- SLO2: `blocked` 30分超を残さない
- SLO3: retry exhaustion の可視化

Dashboard Overview で以下を表示:

- `QUEUE AGE MAX`
- `BLOCKED > 30M`
- `RETRY EXHAUSTED`
