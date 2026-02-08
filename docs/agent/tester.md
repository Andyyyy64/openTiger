# Tester Agent

最終更新: 2026-02-06

## 1. 役割

テスト関連taskを担当する専用workerロール。

実体は Worker と同じ実行基盤を使い、`AGENT_ROLE=tester` で動作する。

## 2. 期待される仕事

- 既存実装に対する検証コマンド整備
- 単体/統合/E2Eテストの追加
- 失敗ログの要約

## 3. 現在の設計方針

- テストtaskは Planner 側で `role=tester` を付与
- Dispatcher は role に応じて tester agent へ配布
- verifyコマンドは non-interactive で終了するものを使う

## 4. 推奨運用

- `vitest run` を使う（watch禁止）
- E2Eは専用ポートで起動
- 結果は run/artifact に残し、Judge が追跡できるようにする

## 5. 主な設定

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `OPENTIGER_E2E_PORT`

## 6. 未実装/改善余地

- flake の自動判定精度向上
- 変更差分に応じたテスト範囲推定
- E2E成果物保存の標準化
