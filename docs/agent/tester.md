# テスター（Tester）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/agent/worker.md`
- `docs/verification.md`

## 1. 役割

Tester は `AGENT_ROLE=tester` で動作する Worker ランタイムの派生ロールです。  
このページは Tester 固有の差分のみを記載します。

共通の実行フロー・状態遷移・安全制約は `docs/agent/worker.md` を参照してください。

## 2. 主な責務

- unit/integration/e2e テストの追加・修正
- 不安定な検証コマンドの安定化
- Judge や autofix ループで再現可能な失敗文脈の提供

## 3. 配布前連携（Planner/Dispatcher）

- Planner が task 内容やパスのヒントから tester ロールを推定
- Dispatcher がロール付き task を idle な tester へ割り当て

## 4. 検証方針

- 非対話コマンドのみ許可
- watch モードコマンドは避ける
- Planner/Worker の verify contract を利用可能
- e2e コマンドは「明示的に e2e 要求がある task」にのみ自動補完される

## 5. 主な設定

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`

共通設定（retry/policy recovery/verify recovery など）は `docs/agent/worker.md` を参照してください。

## 6. 実装参照（source of truth）

- role 起動分岐: `apps/worker/src/main.ts`
- role 固有指示: `apps/worker/instructions/tester.md`
- 検証コマンド自動補完: `apps/worker/src/steps/verify/repo-scripts.ts`
- 共通実行本体: `apps/worker/src/worker-runner.ts`, `apps/worker/src/worker-runner-verification.ts`
