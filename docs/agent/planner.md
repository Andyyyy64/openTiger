# Planner Agent

関連:

- `docs/agent/README.md`
- `docs/flow.md`
- `docs/verification.md`

## 1. Role

Planner は requirement/issue から実行可能な task 群を生成し、重複なく永続化します。  
重複計画を避けるため、運用上は単一インスタンス前提です。

## 2. Inputs

- requirement content/file
- 既存 backlog と dependency 情報
- judge feedback / failure hints
- repository inspection 結果
- policy recovery ヒント（過去イベント由来）

## 3. Pipeline

1. requirement parse/validate
2. 既存コンテキスト（feedback/hints）読込
3. inspection 実行（LLM）
4. task 生成（LLM + fallback）
5. dependency 正規化
6. role / allowedPaths / command policy 適用
7. verification command 補強
8. plan 保存（dedupe lock 付き）
9. 必要に応じて issue 連携

## 4. Key Behaviors

- uninitialized repository 向け init task 注入
- dependency index の循環/冗長除去
- lockfile path の自動許可
- command-driven allowedPaths 補完
- doc gap 検知と docser task 注入
- policy recovery hint の将来 task への反映
- `planner.plan_created` イベントに plan summary を保存

## 5. Verification Command Augmentation

Planner は task 生成時に検証コマンドを補強できます。

- `PLANNER_VERIFY_COMMAND_MODE=off|fallback|contract|llm|hybrid`（既定: `hybrid`）
- verify contract: `.opentiger/verify.contract.json`（パスは変更可能）
- LLM 計画失敗時は warning を残し、Worker 側の自動戦略へ委譲

## 6. Start Constraints

以下 backlog があると Planner start はブロックされます。

- local task backlog
- issue task backlog
- PR/judge backlog

これは backlog-first 運用を保証するための仕様です。

## 7. Failure Model

- inspection は retry + quota-aware
- inspection/task generation が失敗しても fallback planning を試行
- hard failure 時は既存タスクを壊さず終了

## 8. Important Settings

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
