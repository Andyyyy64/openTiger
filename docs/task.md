# 実装状況と優先バックログ

最終更新: 2026-02-06

## 1. 現在の到達点

「止まらず並列で完走」を目標にした基盤修正は完了。

完了済み:

- [x] Judge冪等化
  - `runs.judged_at` / `judgement_version`
- [x] blocked reason 導入
  - `awaiting_judge` / `needs_rework` / `needs_human`
- [x] blocked 自動解消
  - reason別遷移
- [x] concurrency制御の一本化
  - busy agent ベース
- [x] verify の非破壊化
  - verify中の自動ファイル修正を廃止
- [x] deniedCommands 二重防御
  - verify前 + OpenCode前
- [x] 失敗分類と適応リトライ
  - `env/setup/policy/test/flaky/model`
- [x] 観測性改善
  - queue age / blocked age / retry exhaustion

## 2. まだ残っている重要タスク

### 2.1 needs_human の運用実装

- [ ] 隔離イベントだけでなく専用キュー/ステータスを実装
- [ ] ダッシュボードから再開・差し戻しを操作可能にする

### 2.2 health/ready の実体化

- [ ] DB接続チェックの実装
- [ ] Redis接続チェックの実装
- [ ] Queue疎通チェックの実装

### 2.3 統合テスト強化

- [ ] retry分類ロジックのテスト
- [ ] blocked reason 別遷移のテスト
- [ ] Judge claim（冪等性）の競合テスト

### 2.4 運用自動化

- [ ] triager ロール導入
- [ ] planner 再帰分割
- [ ] docser 更新ルールの機械化

## 3. 運用SLO

- [x] 定義済み
- [ ] SLO逸脱時の自動アクションをさらに強化

SLO:

- queued -> running: 5分以内
- blocked: 30分以内に処理
- retry exhaustion: 常時監視

## 4. リリース判定の最低条件

- [ ] `pnpm run check` が安定して通る
- [ ] 主要シナリオで E2E が通る
- [ ] 24時間運転で SLO逸脱が閾値内
