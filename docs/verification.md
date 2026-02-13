# 検証（Verification）コマンド戦略

openTiger は Planner と Worker の両方で検証コマンドを扱います。  
このドキュメントは、`task.commands` の生成・実行・回復の実装仕様をまとめます。

関連:

- `docs/policy-recovery.md`
- `docs/state-model.md`
- `docs/flow.md`
- `docs/operations.md`
- `docs/agent/planner.md`
- `docs/agent/worker.md`

### 状態詰まり時の読み順（検証失敗から入る場合）

検証失敗を起点に調査する場合は、次の順で辿ると切り分けしやすくなります。

1. `docs/state-model.md`（`needs_rework` / `quota_wait` などの状態語彙）
2. `docs/flow.md`（Worker 失敗処理と回復遷移）
3. `docs/operations.md`（API 手順と運用ショートカット）
4. `docs/agent/README.md`（担当 agent と実装追跡ルート）

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

### 検証契約（verify contract）の扱い

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

## 7. 運用時の観測ポイント（一次切り分け）

| 症状 | まず確認する API | 見るポイント |
| --- | --- | --- |
| command failure が連続する | `GET /runs`, `GET /tasks`, `GET /logs/all` | 同一 command の繰り返し失敗、recovery attempt の有無 |
| no-change failure が続く | `GET /runs/:id`, `GET /tasks/:id` | no-op success 判定まで到達しているか、retry 回数 |
| policy violation で進まない | `GET /runs/:id`, `GET /tasks/:id`, `GET /logs/all` | `blocked(needs_rework)` への遷移理由、allowedPaths 調整ログ |
| quota 系で待機が続く | `GET /tasks`, `GET /runs`, `GET /logs/all` | `blocked(quota_wait)` の増加、cooldown 復帰が再開しているか |

補足:

- 全体の運用確認順は `docs/operations.md` のチェックリストを参照してください。
- 状態語彙（`quota_wait`, `needs_rework` など）は `docs/state-model.md` を参照してください。
