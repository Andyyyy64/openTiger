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

## 5. Cycle Status

- `running`
- `completed`
- `aborted`

## 6. 参照時の使い分け

- 状態の意味を確認したい: このページ
- どの条件で遷移するか知りたい: `docs/flow.md`
- 起動時の判定式を知りたい: `docs/startup-patterns.md`
