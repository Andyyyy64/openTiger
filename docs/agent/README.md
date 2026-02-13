# Agent Specs Index

このページは、openTiger の各 agent の責務と違いを横断的に確認するための索引です。

## 1. Agent 比較表

| Agent | 主責務 | 主入力 | 主要遷移/出力 | 主な失敗時挙動 |
| --- | --- | --- | --- | --- |
| Planner | requirement/issue から task 計画生成 | requirement, backlog, feedback, inspection | `tasks` 作成、plan event 保存 | fallback planning、重複計画ガード |
| Worker | 実装変更 + 検証 + PR 化 | task, repo/worktree, commands | `runs/artifacts` 生成、`awaiting_judge` or `done` | `quota_wait` / `needs_rework` / `failed` |
| Tester | テスト中心タスク実行 | tester role task | Worker と同等（テスト文脈） | Worker と同等 |
| Docser | ドキュメント同期タスク実行 | docser role task | docs 更新 run/artifact | doc-safe command 制約、LLM policy recovery なし |
| Judge | success run の評価と統治 | run/artifacts, CI/policy/LLM result | `done` or retry/rework/autofix | circuit breaker、autofix、awaiting_judge 復元 |

## 2. 役割の使い分け

- **Planner** は「何を実行するか」を決める。
- **Dispatcher** は「誰に実行させるか」を決める（本ページの対象外）。
- **Worker/Tester/Docser** は「実行して検証する」。
- **Judge** は「結果を承認するか、再修正へ戻すか」を決める。

## 3. 実行対象の差分（Worker 系）

| 観点 | Worker | Tester | Docser |
| --- | --- | --- | --- |
| 主変更対象 | 実装コード | テストコード | ドキュメント |
| 検証コマンド | task/policy に従う | task/policy に従う（テスト中心） | doc-safe command 優先 |
| LLM policy recovery | 有効化可能 | 有効化可能 | 実行しない |
| 典型タスク | 機能追加・不具合修正 | テスト追加・不安定検証の改善 | docs 同期・不足補完 |

Worker / Tester / Docser は同一 runtime を共有し、`AGENT_ROLE` で挙動を切り替えます。

## 4. モデル/指示ファイルの解決順

| Role | Model 設定（優先順） | Instructions 設定（優先順） |
| --- | --- | --- |
| worker | `WORKER_MODEL` -> `OPENCODE_MODEL` | `WORKER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/base.md` |
| tester | `TESTER_MODEL` -> `OPENCODE_MODEL` | `TESTER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/tester.md` |
| docser | `DOCSER_MODEL` -> `OPENCODE_MODEL` | `DOCSER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/docser.md` |

`LLM_EXECUTOR=claude_code` の場合は role 別 model より `CLAUDE_CODE_MODEL` が優先されます。

## 5. 共通の状態モデル

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

## 6. 詳細仕様

- `docs/agent/planner.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`

関連:

- `docs/flow.md`
- `docs/policy-recovery.md`
- `docs/verification.md`
