# openTiger Documentation Index

このディレクトリは、openTiger の実装仕様を「導線」と「参照」に分けて整理しています。  
ソースコードを真として、運用に必要な情報を段階的に読める構成です。

## 1. 初見ユーザー向け（最短導線）

1. `docs/getting-started.md`
   - 導入、初回起動、Start ページでの実行開始まで
2. `docs/architecture.md`
   - コンポーネント責務とデータフロー
3. `docs/config.md`
   - `system_config` と環境変数の設定参照
4. `docs/api-reference.md`
   - Dashboard/API 連携時の主要エンドポイント参照
5. `docs/operations.md`
   - 運用、障害復旧、ログ確認、runtime hatch

## 2. 実行モデル・復旧戦略

- `docs/flow.md`
  - エンドツーエンドの状態遷移と回復ループ
- `docs/startup-patterns.md`
  - 起動時 preflight 判定と runtime 収束条件
- `docs/mode.md`
  - `REPO_MODE` / `JUDGE_MODE` / 実行モードの運用指針
- `docs/execution-mode.md`
  - host/sandbox 実行差分と sandbox 認証
- `docs/policy-recovery.md`
  - policy violation 回復、allowedPaths 自己成長
- `docs/verification.md`
  - Planner/Worker の検証コマンド解決戦略

## 3. Agent 仕様

- `docs/agent/planner.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`

## 4. 設計思想・補助資料

- `docs/nonhumanoriented.md`
  - non-stalling を前提とした設計原則
- `docs/requirement.md`
  - requirement テンプレート例
- `docs/idea.md`
  - 改善アイデアメモ（将来計画）
