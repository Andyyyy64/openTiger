# プランナー（Planner）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/verification.md`

## 1. 役割

Planner は requirement/issue から実行可能な task 群を生成し、重複なく永続化します。  
重複計画を避けるため、運用上は単一インスタンス前提です。

責務外:

- task 実行（コード変更・検証コマンド実行）
- run 成果物の judge 判定

## 2. 入力

- requirement の内容/ファイル
- 既存 backlog と dependency 情報
- Judge の feedback / failure hints（失敗ヒント）
- repository inspection の結果
- policy recovery ヒント（過去イベント由来）

## 3. 処理パイプライン

1. requirement の解析と妥当性確認（parse/validate）
2. 既存コンテキスト（feedback/hints）読込
3. inspection 実行（LLM）
4. task 生成（LLM + fallback 経路）
5. dependency の正規化
6. role / allowedPaths / command policy 適用
7. verification command 補強
8. plan 保存（dedupe lock 付き）
9. 必要に応じて issue と連携

## 4. 主な挙動

- 未初期化 repository 向けの init task 注入
- dependency index の循環/冗長除去
- lockfile path の自動許可
- command-driven allowedPaths 補完
- doc gap 検知と docser task 注入
- policy recovery hint の将来 task への反映
- `planner.plan_created` イベントに plan summary を保存

## 5. 検証コマンド補強

Planner は task 生成時に検証コマンドを補強できます。

- `PLANNER_VERIFY_COMMAND_MODE=off|fallback|contract|llm|hybrid`（既定: `hybrid`）
- verify contract: `.opentiger/verify.contract.json`（パス変更可能）
- LLM 計画失敗時は warning を残し、Worker 側の自動戦略へ委譲

## 6. 起動制約

以下 backlog があると Planner start はブロックされます。

- local task backlog
- issue task backlog
- PR/judge backlog

これは backlog-first 運用を保証するための仕様です。

## 7. 失敗モデル

- inspection は retry + quota-aware で実行
- inspection/task generation が失敗しても fallback planning を試行
- hard failure 時も既存タスクを壊さず終了

## 8. 実装参照（source of truth）

- 起動と全体制御: `apps/planner/src/main.ts`, `apps/planner/src/planner-runner.ts`
- task 永続化と plan event: `apps/planner/src/planner-tasks.ts`
- task policy / allowedPaths 補正: `apps/planner/src/task-policies.ts`
- 検証コマンド補強: `apps/planner/src/planner-verification.ts`
- issue 起点の task 化: `apps/planner/src/strategies/from-issue.ts`

## 9. 主な設定

- `PLANNER_MODEL`
- `PLANNER_TIMEOUT`
- `PLANNER_INSPECT_TIMEOUT`
- `PLANNER_INSPECT_MAX_RETRIES`
- `PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS`
- `PLANNER_DEDUPE_WINDOW_MS`
- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `PLANNER_VERIFY_COMMAND_MODE`
- `PLANNER_VERIFY_CONTRACT_PATH`
- `PLANNER_VERIFY_MAX_COMMANDS`
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
