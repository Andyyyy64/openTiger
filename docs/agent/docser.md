# ドキュメント担当（Docser）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/agent/worker.md`
- `docs/verification.md`
- `docs/policy-recovery.md`

## 1. 役割

Docser は `AGENT_ROLE=docser` で動作する Worker ランタイムの派生ロールです。  
このページは Docser 固有の差分のみを記載します。

共通の実行フロー・状態遷移・安全制約は `docs/agent/worker.md` を参照してください。

## 2. 主な起点

- Judge 後のドキュメント追従 task 作成
- repository の docs が不足・未整備な場合の Planner による doc-gap task 注入

## 3. 期待される出力

- allowed paths 配下に限定した簡潔なドキュメント差分
- run/task レコードに紐づく検証済みドキュメント更新

## 4. ガードレール

- 推測的な設計案より、実装済みの事実を優先する
- strict な allowed paths を厳守する
- 変更をレビュー可能なサイズに保ち、影響範囲を絞る
- doc-safe な検証コマンド（例: `pnpm run check`）を使う
- LLM ベースの policy recovery は行わず、deterministic な処理に限定する

## 5. 主な設定

- `AGENT_ROLE=docser`
- `DOCSER_MODEL`
- `DOCSER_INSTRUCTIONS_PATH`
- `OPENTIGER_LOG_DIR`

共通設定（retry/policy recovery/verify recovery など）は `docs/agent/worker.md` を参照してください。
