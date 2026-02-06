# アイデアメモ（次フェーズ）

最終更新: 2026-02-06

現状の実装は「止まりにくい並列実行」まで到達した。
次は品質と運用体験を高めるフェーズに進む。

## 1. 短期（優先）

### 1.1 needs_human 専用キューの実体化

- 現在は隔離イベントのみ
- 専用ステータス/キュー/UIを追加して運用を明確化する

### 1.2 triager ロールの導入

- 失敗分類を task 分割・再計画へ直接つなぐ
- Cycle Manager の回復処理を補助する専任ロール

### 1.3 health API 拡張

- `/health/ready` で DB/Redis/Queue の実チェック
- SLO逸脱数も返せるようにする

## 2. 中期

### 2.1 tester 強化

- 差分に応じたテスト選択
  - unit / integration / e2e
- flake検知と自動隔離

### 2.2 docser 強化

- docs不足検知の精度向上
- 変更種別ごとの更新テンプレート化

### 2.3 planner の再帰分割

- 大規模要件で sub-planner を展開
- 衝突領域を先に推定して task 生成時に回避

## 3. 長期

### 3.1 deployer + observer

- staging/prod 反映と自動ロールバック
- 運用メトリクス起点で修正タスク自動生成

### 3.2 requirement interview

- 要件の曖昧点を自動質問して確定化
- 要件自体の履歴管理・差分管理

## 4. 目標指標

- 実行成功率
- 平均 task 完了時間
- retry exhaustion 発生率
- blocked 30分超件数
- queued 5分超件数
