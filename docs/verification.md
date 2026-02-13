# Verification Command Strategy

openTiger は Planner と Worker の両方で検証コマンドを扱います。  
このドキュメントは、`task.commands` の生成・実行・回復の実装仕様をまとめます。

関連:

- `docs/policy-recovery.md`
- `docs/agent/planner.md`
- `docs/agent/worker.md`

## 1. 全体像

1. Planner が task を生成
2. Planner が `task.commands` を補強（mode に応じて）
3. Worker が command を順に実行
4. 失敗時は verification recovery / policy recovery / rework へ分岐

## 2. Planner 側

Planner の検証コマンドモード:

- `PLANNER_VERIFY_COMMAND_MODE=off|fallback|contract|llm|hybrid`（既定: `hybrid`）

主要設定:

- `PLANNER_VERIFY_CONTRACT_PATH`（既定: `.opentiger/verify.contract.json`）
- `PLANNER_VERIFY_MAX_COMMANDS`（既定: `4`）
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `PLANNER_VERIFY_AUGMENT_NONEMPTY`

### verify contract

`verify.contract.json` の例:

```json
{
  "commands": ["pnpm run check"],
  "byRole": {
    "tester": ["pnpm run test"]
  },
  "rules": [
    {
      "whenChangedAny": ["apps/api/**"],
      "commands": ["pnpm --filter @openTiger/api test"]
    }
  ]
}
```

## 3. Worker 側

Worker の自動補完モード:

- `WORKER_AUTO_VERIFY_MODE=off|fallback|contract|llm|hybrid`（既定: `hybrid`）

主要設定:

- `WORKER_VERIFY_CONTRACT_PATH`（既定: `.opentiger/verify.contract.json`）
- `WORKER_AUTO_VERIFY_MAX_COMMANDS`（既定: `4`）
- `WORKER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `WORKER_VERIFY_PLAN_PARSE_RETRIES`
- `WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS`

docser の場合は doc-safe command（例: `pnpm run check`）に制限されます。

## 4. 実行制約

verification command は shell 経由ではなく直接実行されるため、以下は不可です。

- command substitution: `$()`
- shell operator: `|`, `&&`, `||`, `;`, `<`, `>`, `` ` ``

missing script / unsupported format の explicit command は、条件に応じて skip される場合があります。

## 5. no-change と recovery

Worker は以下を実装しています。

- no-change failure 時の再実行
- no-change でも verification pass が確認できれば no-op success 扱い
- command failure の recovery attempt

主要設定:

- `WORKER_NO_CHANGE_RECOVERY_ATTEMPTS`
- `WORKER_NO_CHANGE_CONFIRM_MODE`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT`

## 6. policy violation との関係

verification 中に policy violation が発生した場合:

1. deterministic allowedPaths 調整
2. optional LLM policy recovery（`allow|discard|deny`）
3. generated artifact の discard + 学習
4. それでも解決しなければ `blocked(needs_rework)`

詳細は `docs/policy-recovery.md` を参照してください。
