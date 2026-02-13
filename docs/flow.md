# 実行フロー（Current）

## スコープ

このページは、task/run を中心とした**実行時の状態遷移**を説明します。  
起動時の preflight 判定式や全パターン表は `docs/startup-patterns.md` を参照してください。

## 0.1 状態モデルから読むときの入口

状態語彙から入る場合は、まず `docs/state-model.md` で用語を確定し、その後このページで遷移と回復経路を確認します。

| 状態語彙の確認先（state-model） | このページで次に読む節 | 主担当 agent |
| --- | --- | --- |
| 「1. Task Status」「2. Task Block Reason」 | 「2. 基本ライフサイクル」「3. 回復で使われる Blocked Reason」 | Dispatcher / Worker / Judge |
| 「2.2 Task Retry Reason の見方（実運用）」 | 「6. Worker の失敗処理」「8. Cycle Manager の自己回復」 | Worker / Cycle Manager |
| 「7. 状態遷移で停滞しやすいパターン」 | 「5. Dispatcher の回復レイヤ」「7. Judge の非承認 / マージ失敗経路」 | Dispatcher / Judge |

## 1. 起動 / preflight

システム起動時は `/system/preflight` を呼び出し、推奨起動構成を組み立てます。

確認する入力:

- requirement の内容
- GitHub の open issue
- GitHub の open PR
- ローカル task backlog（`queued/running/failed/blocked`）

判定ルール:

- `startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog`
- 実行系 agent（`dispatcher/worker/tester/docser`）は planner 作業または backlog があるとき起動
- judge は judge backlog があるか、実行系 agent が動作中のとき起動
- planner process 数は最大 1

代表的な警告の意味:

- `Issue backlog detected (...)`
  - backlog-first モードが有効
- `Planner is skipped for this launch`
  - issue/pr backlog がある場合の正常挙動

判定の厳密な式・全組み合わせは `docs/startup-patterns.md` に集約しています。

## 2. 基本ライフサイクル

1. Task が `queued` に入る
2. Dispatcher が lease を取得し task を `running` にする
3. 実行 role（`worker/tester/docser`）が task と検証コマンドを実行
   - LLM 実行前に worker は次から圧縮プロンプトコンテキストを構築:
     - 静的 instructions（`apps/worker/instructions/*.md`）
     - 実行時 snapshot（`.opentiger/context/agent-profile.json`）
     - 失敗差分（`.opentiger/context/context-delta.json`）
   - prompt 膨張を避けるため、context 注入は固定文字数の budget で制御
4. 成功時:
   - review が必要なら通常 `blocked(awaiting_judge)`
   - 直接完了なら `done`
5. Judge が成功 run を評価
6. Task は次へ遷移:
   - `done`
   - `blocked(awaiting_judge)`（retry/recovery）
   - `blocked(needs_rework)`（split/autofix 経路）
7. Cycle Manager が収束まで継続的に requeue / rebuild する

## 3. 回復で使われる Blocked Reason

定義一覧は `docs/state-model.md` を参照してください。

- `awaiting_judge`
  - 成功 run があるが未判定、または run 復元が必要
- `quota_wait`
  - worker が LLM quota エラーを検知し、cooldown retry のため待機
- `needs_rework`
  - non-approve 昇格、失敗シグネチャ反復、または明示的 autofix 経路

互換性のため、legacy の `needs_human` は有効な回復経路へ正規化されます。

その他の runtime blocked reason:

- `issue_linking`
  - planner が issue-link metadata 解決まで task を一時待機させ、解決後に `queued` へ戻す

## 4. Run Lifecycle と Judge の冪等性

- Worker は開始時に `runs(status=running)` を作成
- Worker は run を `success/failed` に更新
- Judge は未判定の成功 run のみを対象化
- Judge は review 前に run を原子的に claim（`judgedAt`, `judgementVersion`）

結果:

- 同一 run の二重 review を防止
- 重複 judge loop を抑制

## 5. Dispatcher の回復レイヤ

poll loop ごとに:

- 期限切れ lease のクリーンアップ
- dangling lease のクリーンアップ
- dead-agent lease の reclaim
- active run がない orphaned `running` task の回復

タスクのフィルタ条件:

- 未解決 dependency は block
- `targetArea` 競合は block
- 直近の非 quota failure は cooldown block 対象
- 最新 quota failure は dispatcher 側 cooldown block から除外

## 6. Worker の失敗処理

task error 時:

- run を `failed` に更新
- task を次のように更新:
  - quota シグネチャに一致する場合は `blocked(quota_wait)`
  - それ以外は `failed`
- failure signature に応じて context delta（`.opentiger/context/context-delta.json`）を更新する場合あり
- lease を解放
- agent を `idle` に戻す

Queue 重複実行防止:

- task ごとの runtime lock
- lock 競合時の起動直後ガード（誤った即時 requeue を回避）

## 7. Judge の非承認 / マージ失敗経路

- 非承認で AutoFix task 作成、および親 task -> `blocked(needs_rework)` への遷移が起こる場合あり
- 承認後でもマージ競合があれば `[AutoFix-Conflict] PR #...` を生成する場合あり
- 競合 autofix の enqueue に失敗した場合は judge retry fallback を使用

## 8. Cycle Manager の自己回復

周期ジョブの主な内容:

- timeout run の cancellation
- lease クリーンアップ
- offline agent の reset
- failed task の cooldown requeue（failure classification 付き。unsupported/missing verification command は block ではなく command 調整へ）
- blocked task の reason 別 cooldown 回復
- backlog ordering gate
  - `local task backlog > 0`: task 実行を継続
  - `local task backlog == 0`: `/system/preflight` を実行して issue backlog を import/sync
  - `issue backlog == 0`: planner の再計画（replan）を起動

起動判定・replan 判定の責務分離は `docs/startup-patterns.md` を参照してください。

blocked 回復挙動:

- `awaiting_judge`
  - 必要に応じて最新の judge 可能な成功 run を復元
  - それ以外は timeout-requeue（PR review task は ping-pong 回避のため `awaiting_judge` を維持）
- `quota_wait`
  - cooldown 後に requeue
- `needs_rework`
  - PR review task: `awaiting_judge` へ戻す
  - 通常 task: `[Rework] ...` task を生成し、親を failed lineage へ移動
  - policy-only violation は `allowedPaths` 調整後の in-place requeue が可能。安全経路がなければ rework split を抑制（retry 上限後に cancel）
  - 有効な rework child が既にある場合は追加 rework を作らない
  - rework depth が `AUTO_REWORK_MAX_DEPTH` を超えた場合は cancel

system process の自己回復:

- Judge backlog（`openPrCount > 0` または `pendingJudgeTaskCount > 0`）を検知すると runtime hatch を arm し、Judge process 停止時に自動起動

policy のライフサイクルと自己成長の詳細:

- `docs/policy-recovery.md`

## 9. Host snapshot と context 更新

- API の host context endpoint:
  - `GET /system/host/neofetch`
  - `GET /system/host/context`
- snapshot の主ソースは `neofetch`。必要時は `uname -srmo` に fallback
- snapshot は `.opentiger/context/agent-profile.json` に cache され、TTL/fingerprint で更新

## 10. `Failed` と `Retry` が共存する理由

Runs table で即時 failed を表示しつつ、task card で retry countdown を表示することがあります。

例:

- run status: `failed`（その試行の実結果）
- task retry: `quota 79s`（次の回復試行が既に予定済み）

これは停止ではなく、能動的な回復動作です。

## 関連する Agent 仕様

- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/docser.md`
- `docs/agent/judge.md`
- `docs/agent/cycle-manager.md`

実装を直接追う場合は、各ページ末尾の「実装参照（source of truth）」節から対応する `apps/*/src` を確認してください。
