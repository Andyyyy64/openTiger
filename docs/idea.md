# 今後のアイデア

## 1. Planner Fallback Layer

- inspection が連続失敗したときに使える optional な `degraded planning` mode を追加する
- planning を hard abort せず、最小安全 task を生成する

## 2. Recovery Explainability

- task 単位の状態遷移を示す timeline panel を第一級機能として追加する
- reason の変化（`quota_wait -> queued -> running -> awaiting_judge`）を可視化する

## 3. Judge Throughput Controls

- awaiting backlog の増減傾向に応じて judge 数を動的スケーリングする
- 最も古い blocked 親 task を持つ PR を優先評価する

## 4. Retry Policy Profiles

- profile ベースの retry policy（`aggressive`, `balanced`, `cost-save`）を追加する
- config row ごとに project 単位 override を許可する

## 5. Safety Hardening

- 想定外 external path への preflight permission check を強化する
- worker instruction へ path を渡す前に明示的 validation を追加する

## 6. 共通逆引き導線（状態語彙 -> 遷移 -> 担当 -> 実装、アイデア評価時）

改善案を試すときは、影響の有無を状態語彙 -> 遷移 -> 担当 -> 実装の順で確認すると比較しやすくなります。

1. `docs/state-model.md`（状態語彙がどう変わるか）
2. `docs/flow.md`（遷移と回復経路にどんな差分が出るか）
3. `docs/operations.md`（運用時の API 確認手順に変更が要るか）
4. `docs/agent/README.md`（担当 agent と実装責務に影響があるか）
