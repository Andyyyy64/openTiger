# 非人間運用の原則

最終更新: 2026-02-06

## 1. 目標

人手介入なしで、長時間・並列実行を継続する。

この目標の評価軸は次の3点。

- 停滞しない
- 同一失敗を無限反復しない
- 並列でも壊れない

## 2. 設計原則

- 役割分離
  - Planner / Dispatcher / Worker / Judge / Cycle Manager を分離
- 判定の機械化
  - `commands`, policy, CI, Judge verdict で遷移を決定
- 回復前提
  - failed / blocked / orphan / timeout を自動処理
- 冪等性
  - 同じrunを二重評価しない
  - 同じtaskを重複実行しない

## 3. 主要な停止回避メカニズム

### 3.1 Judge冪等化

- `runs.judgedAt` と `judgementVersion` で同一run再判定を防止
- claim済みrunは再レビューしない

### 3.2 blockReason による blocked 制御

- `awaiting_judge`
- `needs_rework`
- `needs_human`

reason別に挙動を分けることで、停滞を防ぎつつ危険操作を隔離する。

### 3.3 適応リトライ

失敗分類:

- `env/setup/policy/test/flaky/model`

分類ごとに再試行上限を変更し、盲目的な再試行を止める。

### 3.4 並列制御の一貫化

- 同時実行枠は busy agent 数ベース
- `targetArea` 衝突回避
- lease + orphan recovery

## 4. SLO

- `queued -> running` 5分以内
- `blocked` 30分超を残さない
- retry exhaustion を可視化

## 5. 人間介入の境界

自動化を止めるべき条件:

- `needs_human` が継続する高リスク変更
- policy違反が連続するタスク
- 外部環境依存（認証/インフラ）で自動解決不能

自動化を止めない条件:

- flaky/一時失敗
- merge API失敗などの一過性エラー

## 6. 運用上の注意

- verifyは非破壊を維持する
  - 検証のために `package.json` を書き換えない
- denyコマンドは二重防御で止める
  - verify前 + OpenCode実行前
- ログは task/run 単位で保存し、次回retryの文脈に再利用する
