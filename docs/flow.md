# Operation Flow（Current）

## Scope

このページは、task/run を中心とした**実行時の状態遷移**を説明します。  
起動時の preflight 判定式や全パターン表は `docs/startup-patterns.md` を参照してください。

## 1. Start / Preflight

システム起動時は `/system/preflight` を呼び出し、推奨起動構成を組み立てます。

確認する入力:

- requirement content
- GitHub open issues
- GitHub open PRs
- local task backlog (`queued/running/failed/blocked`)

判定ルール:

- `startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog`
- 実行系 agent（`dispatcher/worker/tester/docser`）は planner 作業または backlog があるとき起動
- judge は judge backlog があるか、実行系 agent が動作中のとき起動
- planner process 数は最大 1

代表的な warning の意味:

- `Issue backlog detected (...)`
  - backlog-first mode が有効
- `Planner is skipped for this launch`
  - issue/pr backlog がある場合の正常挙動

判定の厳密な式・全組み合わせは `docs/startup-patterns.md` に集約しています。

## 2. Primary Lifecycle

1. Task が `queued` に入る
2. Dispatcher が lease を取得し task を `running` にする
3. 実行 role（`worker/tester/docser`）が task と verify command を実行
   - LLM 実行前に worker は次から compact prompt context を構築:
     - static instructions（`apps/worker/instructions/*.md`）
     - runtime snapshot（`.opentiger/context/agent-profile.json`）
     - failure delta（`.opentiger/context/context-delta.json`）
   - prompt 膨張を避けるため、context 注入は固定文字数 budget で制御
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

## 5. Dispatcher Recovery Layer

poll loop ごとに:

- 期限切れ lease の cleanup
- dangling lease の cleanup
- dead-agent lease の reclaim
- active run がない orphaned `running` task の回復

Task filtering:

- 未解決 dependency は block
- `targetArea` 競合は block
- 直近の非 quota failure は cooldown block 対象
- 最新 quota failure は dispatcher 側 cooldown block から除外

## 6. Worker Failure Handling

task error 時:

- run を `failed` に更新
- task を次のように更新:
  - `blocked(quota_wait)` for quota signatures
  - `failed` otherwise
- failure signature に応じて context delta（`.opentiger/context/context-delta.json`）を更新する場合あり
- lease を解放
- agent を `idle` に戻す

Queue 重複実行防止:

- task ごとの runtime lock
- lock 競合時の startup-window guard（誤った即時 requeue を回避）

## 7. Judge Non-Approve / Merge-Failure Path

- Non-approve で AutoFix task 作成、および親 task -> `blocked(needs_rework)` への遷移が起こる場合あり
- Approve 後でも merge conflict があれば `[AutoFix-Conflict] PR #...` を生成する場合あり
- conflict autofix の enqueue に失敗した場合は judge retry fallback を使用

## 8. Cycle Manager Self-Healing

周期ジョブの主な内容:

- timeout run の cancellation
- lease cleanup
- offline agent の reset
- failed task の cooldown requeue（failure classification 付き。unsupported/missing verification command は block ではなく command 調整へ）
- blocked task の reason 別 cooldown 回復
- backlog ordering gate
  - `local task backlog > 0`: keep executing tasks
  - `local task backlog == 0`: run `/system/preflight` to import/sync issue backlog
  - `issue backlog == 0`: trigger planner replan

起動判定・replan 判定の責務分離は `docs/startup-patterns.md` を参照してください。

Blocked recovery behavior:

- `awaiting_judge`
  - 必要に応じて最新の judge 可能な成功 run を復元
  - それ以外は timeout-requeue（PR review task は ping-pong 回避のため `awaiting_judge` 維持）
- `quota_wait`
  - cooldown 後に requeue
- `needs_rework`
  - PR review task: `awaiting_judge` へ戻す
  - 通常 task: `[Rework] ...` task を生成し、親を failed lineage へ移動
  - policy-only violation は `allowedPaths` 調整後の in-place requeue が可能。安全経路がなければ rework split を抑制（retry 上限後に cancel）
  - 有効な rework child が既にある場合は追加 rework を作らない
  - rework depth が `AUTO_REWORK_MAX_DEPTH` を超えた場合は cancel

System process self-heal:

- Judge backlog（`openPrCount > 0` または `pendingJudgeTaskCount > 0`）を検知すると runtime hatch を arm し、Judge process 停止時に自動起動

policy lifecycle と自己成長の詳細:

- `docs/policy-recovery.md`

## 9. Host Snapshot and Context Refresh

- API の host context endpoint:
  - `GET /system/host/neofetch`
  - `GET /system/host/context`
- snapshot の主ソースは `neofetch`。必要時は `uname -srmo` に fallback
- snapshot は `.opentiger/context/agent-profile.json` に cache され、TTL/fingerprint で refresh

## 10. Why "Failed" and "Retry" Can Coexist

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
