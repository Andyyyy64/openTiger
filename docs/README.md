# docs index

Sebastian-code の設計・運用・エージェント仕様の索引。
最終更新: 2026-02-06

## 1. 全体

- `docs/flow.md`
  - 要件生成から実装、Judge、再試行、クリーンアップまでの状態遷移
- `docs/mode.md`
  - `REPO_MODE` / `JUDGE_MODE` / `LAUNCH_MODE` の運用モード
- `docs/nonhumanoriented.md`
  - 人手介入を最小化するための原則とSLO
- `docs/task.md`
  - 実装状況と優先バックログ
- `docs/idea.md`
  - 次フェーズの構想と拡張案

## 2. エージェント別

- `docs/agent/planner.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`

## 3. 2026-02-06 の重要更新

- Judge 冪等化
  - `runs.judged_at` / `judgement_version` を導入し、同一runの再レビューを防止
- blocked reason 導入
  - `awaiting_judge` / `needs_rework` / `needs_human` を運用
- concurrency制御の一本化
  - Dispatcher の同時実行枠を busy agent 数ベースに変更
- verify の非破壊化
  - verify中の `package.json` 自動修正を廃止
- deniedCommands の二重防御
  - verify前 + OpenCode実行前の両方で拒否判定
- 失敗分類と適応リトライ
  - `env/setup/policy/test/flaky/model` に分類して再試行戦略を変更
- 観測性改善
  - `queued->running 5分` / `blocked 30分` / `retry exhaustion` を可視化
