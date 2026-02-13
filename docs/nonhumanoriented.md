# 非人手前提の運用原則

## 1. 目的

人手の常時監視なしで、自律的に進捗し続けることを目的とします。

実運用での定義:

- 無言の deadlock を作らない
- 状態変化のない同一ステップ無限ループを作らない
- 反復失敗は別の recovery 経路へ必ず変換する

完了ポリシー:

- 外部条件を含む全ケースでの完了保証は前提にしない
- システムが意図的に停止し続けないことを保証する
- 進捗が劣化したときは recovery 状態遷移で戦略を強制的に切り替える

## 2. コア原則

- 初回完全成功より Recovery-first
- 冪等な制御点（lease / run claim / dedupe signature）
- backlog-first 起動（新規生成より既存 backlog 解消を優先）
- 機械回復可能な明示 blocked reason

## 3. 停滞防止メカニズム

### 3.1 Lease と Runtime Lock の規律

- task lease で重複 dispatch を防止
- runtime lock で重複実行を防止
- dangling / expired / orphaned lease を継続的に回収

### 3.2 Judge の冪等性

- 未判定の成功 run だけを対象化
- claim 済み run は同時二重判定できない

### 3.3 Halt State ではなく Recovery State を使う

- `awaiting_judge`
- `quota_wait`
- `needs_rework`

planner の issue-link 順序制御に使う runtime blocked state:

- `issue_linking`

状態を放棄せず、回復可能な状態へ変換します。

### 3.4 適応的 Escalation

- 同一 failure signature の反復で rework/autofix へ昇格
- merge-conflict 後の approve は可能なら conflict autofix task へ分岐

### 3.5 Event-Driven な進捗回復

回復切り替えは固定時間トリガーではなく event-driven で実行します。

- 同一失敗シグネチャ反復 -> `needs_rework` / rework split
- non-approve circuit breaker -> autofix path
- quota failure -> `quota_wait` -> cooldown requeue
- judge 可能 run 欠落 -> `awaiting_judge` run context 復元

## 4. Quota に対する考え方

quota 圧は終端失敗ではなく、回復可能な外部圧として扱います。

- 単発 attempt は速やかに失敗してよい
- task は明示理由（`quota_wait`）で待機させる
- リソース回復まで cooldown retry を継続する

## 5. 可観測性要件

運用者は試行結果だけでなく、次の進行意図を観測できる必要があります。

- run レベル失敗
- task レベルの次回 retry reason/time
- preflight が返す backlog gate 理由

## 6. Non-Goals

- 回復性を犠牲にした初回成功率の最大化
- 安全な並列性があるのに厳密逐次処理へ固定
- 手動限定の recovery フロー
- 固定分 watchdog だけに依存した回復設計

## 7. 共通逆引き導線（状態語彙 -> 遷移 -> 担当 -> 実装）

このページは設計思想を示すため、実際の切り分けは状態語彙 -> 遷移 -> 担当 -> 実装の順で確認します。

1. `docs/state-model.md`（状態語彙）
2. `docs/flow.md`（遷移と回復経路）
3. `docs/operations.md`（API 手順と運用ショートカット）
4. `docs/agent/README.md`（担当 agent と実装追跡）
