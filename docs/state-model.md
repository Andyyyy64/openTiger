# State Model Reference

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

## 7. 状態遷移で詰まりやすいパターン（一次診断）

| 症状 | まず見る状態/値 | 主な確認 API | 先に確認する担当領域 |
| --- | --- | --- | --- |
| `queued` が長時間減らない | `agents` の idle/busy、lease、dependency/targetArea 競合 | `GET /agents`, `GET /tasks`, `GET /logs/all` | Dispatcher |
| `running` が長時間固定 | 対応 run の `status`, startedAt、worker ログ | `GET /runs`, `GET /tasks`, `GET /logs/all` | Worker/Tester/Docser |
| `awaiting_judge` が増え続ける | pending judge run、judge process 稼働 | `GET /judgements`, `GET /system/processes`, `GET /logs/all` | Judge |
| `quota_wait` が連鎖する | cooldown 待機時間、同時実行数、モデル quota | `GET /tasks`, `GET /runs`, `GET /logs/all` | Worker + Dispatcher |
| `needs_rework` が連鎖する | non-approve 理由、policy/verification failure の内容 | `GET /judgements`, `GET /runs`, `GET /logs/all` | Judge + Worker + Cycle Manager |

補足:

- 具体的な API 確認順は `docs/operations.md` の「変更後の確認チェックリスト」を参照してください。
- 担当 agent の切り分けに迷う場合は `docs/agent/README.md` の FAQ を参照してください。
