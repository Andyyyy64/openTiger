# Docser Agent

最終更新: 2026-02-06

## 1. 役割

コード変更に追従してドキュメントを更新し、実装と運用手順のズレを防ぐ。

Docser は Worker 基盤上の `AGENT_ROLE=docser` として動作する。

## 2. トリガ

- Judge 承認後に docser task を自動生成
- local mode / git mode の両方で発火可能

## 3. 入力

- 対象runの差分情報
- 元taskの goal / context
- 更新対象ドキュメント

## 4. 出力

- docs更新差分
- 検証結果
- run/task/event 記録

## 5. 重要方針

- 実装事実のみ書く
- 推測で仕様を増やさない
- allowed paths を厳守する
- 変更規模は小さく、レビューしやすく保つ

## 6. 主な設定

- `AGENT_ROLE=docser`
- `DOCSER_MODEL`
- `DOCSER_INSTRUCTIONS_PATH`
- `SEBASTIAN_LOG_DIR`

## 7. 改善余地

- 変更種別ごとのテンプレート化
- doc不足検知の精度改善
- README/docs/task.md の機械集計更新
