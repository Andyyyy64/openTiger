# Agent Specs Index

このページは、openTiger の各 agent の責務と違いを横断的に確認するための索引です。

## 1. Agent 比較表

| Agent | 主責務 | 主入力 | 主要遷移/出力 | 主な失敗時挙動 |
| --- | --- | --- | --- | --- |
| Planner | requirement/issue から task 計画生成 | requirement, backlog, feedback, inspection | `tasks` 作成、plan event 保存 | fallback planning、重複計画ガード |
| Dispatcher | 実行順制御と task 配布 | queued tasks, leases, agent heartbeat | `queued -> running`、lease 付与、agent 割当 | lease reclaim、orphan 回復、再queue |
| Worker | 実装変更 + 検証 + PR 化 | task, repo/worktree, commands | `runs/artifacts` 生成、`awaiting_judge` or `done` | `quota_wait` / `needs_rework` / `failed` |
| Tester | テスト中心タスク実行 | tester role task | Worker と同等（テスト文脈） | Worker と同等 |
| Docser | ドキュメント同期タスク実行 | docser role task | docs 更新 run/artifact | doc-safe command 制約、LLM policy recovery なし |
| Judge | success run の評価と統治 | run/artifacts, CI/policy/LLM result | `done` or retry/rework/autofix | circuit breaker、autofix、awaiting_judge 復元 |
| Cycle Manager | 収束監視・回復・replan 制御 | system state, events, anomaly/cost | cycle 更新、cleanup、replan 起動 | critical anomaly restart、cooldown 再試行 |

## 2. 役割の使い分け

- **Planner** は「何を実行するか」を決める。
- **Dispatcher** は「誰に実行させるか」と「いつ実行させるか」を決める。
- **Worker/Tester/Docser** は「実行して検証する」。
- **Judge** は「結果を承認するか、再修正へ戻すか」を決める。
- **Cycle Manager** は「収束し続ける運用」を維持する。

## 3. Agent 境界（しないこと）

| Agent | しないこと（責務外） |
| --- | --- |
| Planner | task 実行、PR merge 判定 |
| Dispatcher | コード変更、approve/rework 判定 |
| Worker/Tester/Docser | グローバル再計画判断、全体収束制御 |
| Judge | task 配布、実ファイル変更の実行 |
| Cycle Manager | 各 task の中身実装、PR 内容レビュー |

## 4. 実行対象の差分（Worker 系）

| 観点 | Worker | Tester | Docser |
| --- | --- | --- | --- |
| 主変更対象 | 実装コード | テストコード | ドキュメント |
| 検証コマンド | task/policy に従う | task/policy に従う（テスト中心） | doc-safe command 優先 |
| LLM policy recovery | 有効化可能 | 有効化可能 | 実行しない |
| 典型タスク | 機能追加・不具合修正 | テスト追加・不安定検証の改善 | docs 同期・不足補完 |

Worker / Tester / Docser は同一 runtime を共有し、`AGENT_ROLE` で挙動を切り替えます。

重複を避ける読み方:

1. `docs/agent/worker.md` で共通 runtime を把握
2. `docs/agent/tester.md` / `docs/agent/docser.md` で差分のみ確認

## 5. モデル/指示ファイルの解決順

| Role | Model 設定（優先順） | Instructions 設定（優先順） |
| --- | --- | --- |
| worker | `WORKER_MODEL` -> `OPENCODE_MODEL` | `WORKER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/base.md` |
| tester | `TESTER_MODEL` -> `OPENCODE_MODEL` | `TESTER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/tester.md` |
| docser | `DOCSER_MODEL` -> `OPENCODE_MODEL` | `DOCSER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/docser.md` |

`LLM_EXECUTOR=claude_code` の場合は role 別 model より `CLAUDE_CODE_MODEL` が優先されます。

## 6. 共通の状態モデル

task status:

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

blocked reason:

- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `issue_linking`

## 7. 詳細仕様

- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

## 8. よくある誤解（担当 agent の切り分け）

- Q. `queued` task が進まない。Worker の問題か？
  - A. まず Dispatcher を確認します。配布・lease・agent 割当は Dispatcher の責務です。
- Q. `awaiting_judge` が長く残る。Cycle Manager の問題か？
  - A. まず Judge を確認します。approve/rework 判定と backlog 消化は Judge の責務です。
- Q. 同じ失敗が続く。Planner が悪いか？
  - A. 実行中 task の失敗は Worker/Tester/Docser と Cycle Manager 側の再試行・回復を先に確認します。
- Q. 起動時に Planner が動かない。障害か？
  - A. backlog-first の仕様で正常な場合があります。起動判定は preflight / startup ルールを確認します。
- Q. replan が走らない。Dispatcher を見るべきか？
  - A. replan 判定は Cycle Manager の責務です。Planner busy/backlog gate/interval/no-diff 条件を確認します。

関連:

- `docs/flow.md`
- `docs/state-model.md`
- `docs/policy-recovery.md`
- `docs/verification.md`
