# 状態モデル参照

このページは、openTiger の主要ステータスと遷移用語の参照用ドキュメントです。  
状態遷移フローそのものは `docs/flow.md` を参照してください。

関連:

- `docs/flow.md`
- `docs/operations.md`
- `docs/agent/README.md`

## 1. Task Status

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

補足:

- `queued` は Dispatcher 配布待ち
- `running` は lease/run により実行中
- `blocked` は block reason ごとの回復待ち

## 2. Task Block Reason

- `awaiting_judge`
  - 成功 run の judge 待ち、または judge 回復待ち
- `quota_wait`
  - quota 系失敗の cooldown 待ち
- `needs_rework`
  - non-approve / policy・verification 系再作業待ち
- `issue_linking`
  - planner の issue 連携待ち（解決後に `queued` へ復帰）

補足:

- legacy 値 `needs_human` は `awaiting_judge` として扱われます。

## 2.1 Task Retry Reason（`GET /tasks`）

`failed` / `blocked` task には `retry` 情報が付与され、`reason` は次の値を取ります。

- `cooldown_pending`
- `retry_due`
- `retry_exhausted`
- `non_retryable_failure`
- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `unknown`

`failureCategory` が付く場合の値:

- `env`
- `setup`
- `policy`
- `test`
- `flaky`
- `model`
- `model_loop`

## 2.2 Task Retry Reason の見方（実運用）

実運用では、次の値を優先して見れば一次判断しやすくなります。

| `retry.reason` | 意味 | 主な確認先 |
| --- | --- | --- |
| `awaiting_judge` | judge 待ちで停滞中 | `GET /judgements`, `GET /system/processes`, `GET /logs/all` |
| `quota_wait` | quota cooldown 待ち | `GET /tasks`, `GET /runs`, `GET /logs/all` |
| `needs_rework` | rework ループへ移行中 | `GET /runs`, `GET /judgements`, `GET /logs/all` |
| `cooldown_pending` | cooldown 中（自動再試行前） | `GET /tasks` の `retryAt/retryInSeconds` |
| `retry_due` | 再試行可能時刻に到達 | `GET /tasks`, `GET /logs/all` |

## 3. Run Status

- `running`
- `success`
- `failed`
- `cancelled`

## 4. Agent Status

- `idle`
- `busy`
- `offline`

補足:

- この状態は `agents` テーブルに登録される role（`planner/worker/tester/docser/judge`）に適用されます。
- Dispatcher / Cycle Manager は process として管理されるため、`GET /system/processes` で確認します。

## 5. Cycle Status

- `running`
- `completed`
- `aborted`

## 6. 参照時の使い分け

- 状態の意味を確認したい: このページ
- どの条件で遷移するか知りたい: `docs/flow.md`
- 起動時の判定式を知りたい: `docs/startup-patterns.md`

## 6.1 実装参照（source of truth）

- Task status / block reason:
  - `packages/core/src/domain/task.ts`
  - `packages/db/src/schema.ts`（`tasks.status`, `tasks.block_reason`）
- Run status:
  - `packages/core/src/domain/run.ts`
  - `packages/db/src/schema.ts`（`runs.status`）
- Agent status:
  - `packages/core/src/domain/agent.ts`
  - `packages/db/src/schema.ts`（`agents.status`）
- Cycle status:
  - `packages/core/src/domain/cycle.ts`
  - `packages/db/src/schema.ts`（`cycles.status`）

## 7. 状態遷移で停滞しやすいパターン（一次診断）

| 症状 | まず見る状態/値 | 主な確認 API | 先に確認する担当領域 |
| --- | --- | --- | --- |
| `queued` が長時間減らない | `agents` の idle/busy、lease、dependency/targetArea 競合 | `GET /agents`, `GET /tasks`, `GET /logs/all` | Dispatcher |
| `running` が長時間固定 | 対応 run の `status`, startedAt、worker ログ | `GET /runs`, `GET /tasks`, `GET /logs/all` | Worker/Tester/Docser |
| `awaiting_judge` が増え続ける | pending judge run、judge process 稼働 | `GET /judgements`, `GET /system/processes`, `GET /logs/all` | Judge |
| `quota_wait` が連鎖する | cooldown 待機時間、同時実行数、モデル quota | `GET /tasks`, `GET /runs`, `GET /logs/all` | Worker + Dispatcher |
| `needs_rework` が連鎖する | non-approve 理由、policy/verification failure の内容 | `GET /judgements`, `GET /runs`, `GET /logs/all` | Judge + Worker + Cycle Manager |
| `issue_linking` が解消しない | issue 連携メタデータ不足、import/link 処理失敗 | `GET /tasks`, `POST /system/preflight`, `GET /logs/all` | Planner + API |

補足:

- 具体的な API 確認順は `docs/operations.md` の「変更後の確認チェックリスト」を参照してください。
- 担当 agent の切り分けに迷う場合は `docs/agent/README.md` の FAQ を参照してください。

## 8. 状態語彙 -> 遷移 -> 担当 -> 実装 の逆引き（最短ルート）

状態語彙を起点に、状態語彙 -> 遷移 -> 担当 -> 実装の順で追う共通導線です。

| 起点（状態語彙/症状） | 状態語彙の確認先 | 遷移の確認先（flow） | 担当 agent の確認先 | 実装の確認先 |
| --- | --- | --- | --- | --- |
| `queued`/`running` 停滞 | 1章, 2章, 7章 | `docs/flow.md` の「2. 基本ライフサイクル」「5. Dispatcher の回復レイヤ」「6. Worker の失敗処理」 | `docs/agent/dispatcher.md`, `docs/agent/worker.md` | `apps/dispatcher/src/`, `apps/worker/src/` |
| `awaiting_judge` 停滞 | 2章, 7章 | `docs/flow.md` の「3. 回復で使われる Blocked Reason」「4. Run Lifecycle と Judge の冪等性」「7. Judge の非承認 / マージ失敗経路」 | `docs/agent/judge.md` | `apps/judge/src/` |
| `quota_wait`/`needs_rework` 連鎖 | 2章, 2.2章, 7章 | `docs/flow.md` の「3. 回復で使われる Blocked Reason」「6. Worker の失敗処理」「8. Cycle Manager の自己回復」 | `docs/agent/worker.md`, `docs/agent/judge.md`, `docs/agent/cycle-manager.md` | `apps/worker/src/`, `apps/judge/src/`, `apps/cycle-manager/src/` |
| `issue_linking` 停滞 | 2章, 7章 | `docs/flow.md` の「3. 回復で使われる Blocked Reason」 + `docs/startup-patterns.md` | `docs/agent/planner.md` | `apps/planner/src/` |

補足:

- flow 側で責務を確認した後、各 agent 仕様ページ末尾の「実装参照（source of truth）」節へ進むと、ファイル単位で追跡しやすくなります。
