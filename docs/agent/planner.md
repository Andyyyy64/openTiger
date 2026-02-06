# Planner Agent

最終更新: 2026-02-06

## 1. 役割

要件を実行可能な task 群へ分割して `tasks` に保存する。

## 2. 入力

- requirement ファイル
- 既存 task 状態
- policy / allowed paths

## 3. 出力

- task作成
- 依存関係
- 優先度
- リスクレベル

## 4. 重要仕様

- task は機械判定可能な goal を必須とする
- 依存関係は循環・未来参照を補正する
- 未初期化repoでは初期化taskを自動注入する
- 重複計画を避けるため dedupe window を使う

## 5. 主な設定

- `PLANNER_MODEL`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `PLANNER_TIMEOUT`
- `PLANNER_INSPECT`
- `PLANNER_INSPECT_TIMEOUT`
- `PLANNER_DEDUPE_WINDOW_MS`

## 6. 失敗時

- requirement パース不能はエラー記録
- 生成結果が不正なら sanitize して保存
- 重大失敗時は既存taskを壊さず終了

## 7. 運用メモ

- Planner は「最適化」より「詰まらない分割」を優先する
- 依存が濃すぎる計画より、小さく再実行可能な計画を選ぶ
