# テスター（Tester）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/agent/worker.md`
- `docs/verification.md`

## 1. Role

Tester は `AGENT_ROLE=tester` で動作する Worker runtime の派生ロールです。  
このページは Tester 固有の差分のみを記載します。

共通の実行フロー・状態遷移・安全制約は `docs/agent/worker.md` を参照してください。

## 2. Typical Responsibilities

- unit/integration/e2e テストの追加・修正
- flaky な検証コマンドの安定化
- judge/autofix ループ向けの再現性ある失敗文脈の提供

## 3. Planner/Dispatcher Integration

- planner が task の内容や path ヒントから tester role を推定
- dispatcher が role 付き task を idle tester へ割り当て

## 4. Verification Policy

- 非対話コマンドのみ許可
- watch モードコマンドは避ける
- planner/worker verify contract を利用可能
- e2e command は「明示的に e2e 要求がある task」にのみ自動補完される

## 5. Important Settings

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`

共通設定（retry/policy recovery/verify recovery など）は `docs/agent/worker.md` を参照してください。
