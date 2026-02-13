# ドキュメント索引（openTiger）

このディレクトリは、openTiger の実装仕様を「導線」と「参照」に分けて整理しています。  
ソースコードを真として、運用に必要な情報を段階的に読める構成です。

## 0. 目的別ナビゲーション

| 目的 | 最短で読むページ |
| --- | --- |
| まず動かしたい | `docs/getting-started.md` |
| 全体像を掴みたい | `docs/architecture.md` |
| 設定キーを調整したい | `docs/config.md` |
| API 連携したい | `docs/api-reference.md` |
| 障害対応したい | `docs/operations.md` + `docs/flow.md` |
| 状態詰まりを最短で一次診断したい | `docs/state-model.md` |
| `retry.reason` の意味を即確認したい | `docs/state-model.md` |
| 状態語彙から担当 agent と実装まで追いたい | `docs/state-model.md` -> `docs/flow.md` -> `docs/agent/README.md` |
| 起動判定の式を確認したい | `docs/startup-patterns.md` |
| agent の役割差分を確認したい | `docs/agent/README.md` |

## 0.1 読者タイプ別の推奨レーン

### レーンA: 初見ユーザー（最短で動かす）

1. `docs/getting-started.md`
2. `docs/architecture.md`
3. `docs/operations.md`

目的:

- 最初の実行を通す
- 起動後5分チェックまで完了する

### レーンB: 運用担当（安定運用と復旧）

1. `docs/operations.md`
2. `docs/config.md`
3. `docs/state-model.md`
4. `docs/flow.md`
5. `docs/startup-patterns.md`

目的:

- 障害時の切り分けと再起動判断を短時間で行う
- 設定変更の影響範囲を誤らない

### レーンC: 実装追従（ソース差分を追う）

1. `docs/architecture.md`
2. `docs/agent/README.md`
3. `docs/agent/*.md`
4. `docs/api-reference.md`
5. `docs/config.md`

目的:

- コンポーネント責務と実装境界を把握する
- API/設定変更時に関連箇所を漏れなく追う
- `docs/agent/*.md` の「実装参照（source of truth）」からコードへ最短で到達する

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

- `docs/state-model.md`
  - task/run/agent/cycle の状態定義
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

- `docs/agent/README.md`（横断比較）
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

## 4. 設計思想・補助資料

- `docs/nonhumanoriented.md`
  - non-stalling を前提とした設計原則
- `docs/requirement.md`
  - requirement テンプレート例
- `docs/idea.md`
  - 改善アイデアメモ（将来計画）

## 推奨読了順（最短）

1. `docs/getting-started.md`
2. `docs/architecture.md`
3. `docs/config.md`
4. `docs/api-reference.md`
5. `docs/operations.md`
6. `docs/flow.md`
7. `docs/agent/README.md`

## 変更時の逆引き

- 起動条件・replan 条件を変更した場合:
  - `docs/startup-patterns.md`
  - `docs/flow.md`（関連する runtime 影響）
- task 状態遷移や blocked 回復を変更した場合:
  - `docs/state-model.md`
  - `docs/flow.md`
  - `docs/operations.md`
- agent 実装責務を変更した場合:
  - `docs/agent/README.md`
  - 対象の `docs/agent/*.md`
