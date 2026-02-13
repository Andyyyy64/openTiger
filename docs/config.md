# システム設定ガイド

このドキュメントは、openTiger の設定を「DB 管理設定」と「環境変数専用設定（env-only）」に分けて整理します。  
設定の一次ソースは以下です。

- DB 管理キー: `apps/api/src/system-config.ts` (`CONFIG_FIELDS`)
- 環境変数専用設定: 各 runtime 実装（dispatcher/worker/judge/cycle-manager/api）

### 状態詰まり時の読み順（設定変更から入る場合）

設定変更後に停滞が発生した場合は、次の順で確認してください。

1. `docs/state-model.md`（状態語彙の確認）
2. `docs/flow.md`（遷移と回復経路）
3. `docs/operations.md`（API 手順と運用ショートカット）
4. `docs/agent/README.md`（担当 agent と実装追跡ルート）

## 1. 設定の保存先

### データベース管理（`config` テーブル）

- `/config` API から参照/更新
- Dashboard の system settings から更新
- `scripts/export-config-to-env.ts` で `.env` へ同期可能

### 環境変数専用（env-only）設定

- プロセス起動時にのみ参照される設定
- `config` テーブルには保存されない

---

## 2. DB 管理キー一覧（`CONFIG_FIELDS` 準拠）

### 2.1 制限値（Limits）

- `MAX_CONCURRENT_WORKERS`
- `DAILY_TOKEN_LIMIT`
- `HOURLY_TOKEN_LIMIT`
- `TASK_TOKEN_LIMIT`

### 2.2 プロセス有効化 / スケーリング

- `DISPATCHER_ENABLED`
- `JUDGE_ENABLED`
- `CYCLE_MANAGER_ENABLED`
- `EXECUTION_ENVIRONMENT` (`host` or `sandbox`)
- `WORKER_COUNT`
- `TESTER_COUNT`
- `DOCSER_COUNT`
- `JUDGE_COUNT`
- `PLANNER_COUNT`

補足:

- Planner は runtime 上で単一プロセス運用（重複起動ガードあり）

### 2.3 リポジトリ / GitHub

- `REPO_MODE` (`git` or `local`)
- `REPO_URL`
- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`
- `GITHUB_AUTH_MODE` (`gh` or `token`)
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

### 2.4 実行器 / モデル

- `LLM_EXECUTOR` (`opencode` / `claude_code`)
- `OPENCODE_MODEL`
- `OPENCODE_SMALL_MODEL`
- `OPENCODE_WAIT_ON_QUOTA`
- `OPENCODE_QUOTA_RETRY_DELAY_MS`
- `OPENCODE_MAX_QUOTA_WAITS`
- `CLAUDE_CODE_PERMISSION_MODE`
- `CLAUDE_CODE_MODEL`
- `CLAUDE_CODE_MAX_TURNS`
- `CLAUDE_CODE_ALLOWED_TOOLS`
- `CLAUDE_CODE_DISALLOWED_TOOLS`
- `CLAUDE_CODE_APPEND_SYSTEM_PROMPT`
- `PLANNER_MODEL`
- `JUDGE_MODEL`
- `WORKER_MODEL`
- `TESTER_MODEL`
- `DOCSER_MODEL`

### 2.5 Planner / 再計画（replan）

- `PLANNER_USE_REMOTE`
- `PLANNER_REPO_URL`
- `AUTO_REPLAN`
- `REPLAN_REQUIREMENT_PATH`
- `REPLAN_INTERVAL_MS`
- `REPLAN_COMMAND`
- `REPLAN_WORKDIR`
- `REPLAN_REPO_URL`

### 2.6 LLM プロバイダーキー

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `XAI_API_KEY`
- `DEEPSEEK_API_KEY`

### 2.7 主要デフォルト値（初期状態）

- `EXECUTION_ENVIRONMENT=host`
- `LLM_EXECUTOR=claude_code`
- `BASE_BRANCH=main`
- `REPO_MODE=git`
- `WORKER_COUNT=4`
- `TESTER_COUNT=4`
- `DOCSER_COUNT=4`
- `JUDGE_COUNT=4`
- `PLANNER_COUNT=1`
- `AUTO_REPLAN=true`
- `REPLAN_REQUIREMENT_PATH=docs/requirement.md`
- `REPLAN_INTERVAL_MS=60000`
- `GITHUB_AUTH_MODE=gh`
- `MAX_CONCURRENT_WORKERS=-1`（無制限扱い）
- `DAILY_TOKEN_LIMIT=-1`（無制限扱い）
- `HOURLY_TOKEN_LIMIT=-1`（無制限扱い）
- `TASK_TOKEN_LIMIT=-1`（無制限扱い）

---

## 3. `/config` API

- `GET /config`
  - 現在の設定スナップショット
- `PATCH /config`
  - body: `{ updates: Record<string, string> }`

挙動:

- 未知キーは拒否
- 指定しないキーは保持
- `AUTO_REPLAN=true` の場合、`REPLAN_REQUIREMENT_PATH` は必須

---

## 4. `/system` API と設定連動

### 4.1 Preflight

- `POST /system/preflight`
- requirement 内容 + local backlog + GitHub backlog から推奨起動構成を返す

Issue 自動 task 化には明示 role が必要:

- label: `role:worker|role:tester|role:docser`
- body: `Agent: ...` / `Role: ...` / `## Agent` section

### 4.2 Process Manager

- `GET /system/processes`
- `GET /system/processes/:name`
- `POST /system/processes/:name/start`
- `POST /system/processes/:name/stop`
- `POST /system/processes/stop-all`

### 4.3 要件 / リポジトリ補助 API

- `GET /system/requirements`
- `POST /system/requirements`
- `POST /system/github/repo`
- `GET /system/github/repos`
- `GET /system/github/auth`
- `GET /system/claude/auth`
- `GET /system/host/neofetch`
- `GET /system/host/context`

### 4.4 Maintenance

- `POST /system/cleanup`

注意:

- runtime テーブルと queue を初期化する破壊的操作です

---

## 5. Requirement 同期の実装挙動

`POST /system/requirements` は次を行います。

1. 入力内容を requirement ファイルへ保存
2. 正規保存先 `docs/requirement.md` へ同期
3. `git` repository の場合、snapshot commit/push を試行

このため requirement 編集は「ファイル保存」だけでなく「repository 状態更新」を伴います。

### 5.1 起動時の自動補完（config-store）

`ensureConfigRow()` は起動時に次の補完/正規化を行います。

- 必須カラムの自己修復（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）
- workspace/git 情報からの自動補完
  - `repoUrl`, `githubOwner`, `githubRepo`, `baseBranch`
  - requirement path 候補（`docs/requirement.md` など）
- 旧値（legacy）の正規化
  - 旧 `REPLAN_COMMAND` を `pnpm --filter @openTiger/planner run start:fresh` へ統一
  - 旧 token/concurrency 固定値を `-1` 無制限へ統一

---

## 6. env-only 主要設定

以下は DB ではなく env で制御される代表例です。

### 6.1 プロセス再起動 / 自己修復

- `SYSTEM_PROCESS_AUTO_RESTART`
- `SYSTEM_PROCESS_AUTO_RESTART_DELAY_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_WINDOW_MS`
- `SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS`
- `SYSTEM_PROCESS_SELF_HEAL`
- `SYSTEM_PROCESS_SELF_HEAL_INTERVAL_MS`
- `SYSTEM_PROCESS_SELF_HEAL_STARTUP_GRACE_MS`
- `SYSTEM_AGENT_LIVENESS_WINDOW_MS`

### 6.2 タスクリトライ / クールダウン

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `DISPATCH_RETRY_DELAY_MS`
- `STUCK_RUN_TIMEOUT_MS`
- `DISPATCH_MAX_POLL_INTERVAL_MS`
- `DISPATCH_NO_IDLE_LOG_INTERVAL_MS`

### 6.3 ポリシー回復

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`
- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`
- `AUTO_REWORK_MAX_DEPTH`

### 6.4 検証コマンド計画

Planner 関連:

- `PLANNER_VERIFY_COMMAND_MODE`
- `PLANNER_VERIFY_CONTRACT_PATH`
- `PLANNER_VERIFY_MAX_COMMANDS`
- `PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `PLANNER_VERIFY_AUGMENT_NONEMPTY`

Worker 関連:

- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_AUTO_VERIFY_MAX_COMMANDS`
- `WORKER_VERIFY_PLAN_TIMEOUT_SECONDS`
- `WORKER_VERIFY_PLAN_PARSE_RETRIES`
- `WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT`
- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT`

### 6.5 Dispatcher / Lease / Agent 生存監視

- `POLL_INTERVAL_MS`
- `DISPATCH_BLOCK_ON_AWAITING_JUDGE`
- `DISPATCH_AGENT_HEARTBEAT_TIMEOUT_SECONDS`
- `DISPATCH_AGENT_RUNNING_RUN_GRACE_MS`
- `TASK_QUEUE_LOCK_DURATION_MS`
- `TASK_QUEUE_STALLED_INTERVAL_MS`
- `TASK_QUEUE_MAX_STALLED_COUNT`

### 6.6 Cycle Manager ループ / 異常検知 / 再計画

- `MONITOR_INTERVAL_MS`
- `CLEANUP_INTERVAL_MS`
- `STATS_INTERVAL_MS`
- `AUTO_START_CYCLE`
- `SYSTEM_API_BASE_URL`
- `ISSUE_SYNC_INTERVAL_MS`
- `ISSUE_SYNC_TIMEOUT_MS`
- `CYCLE_MAX_DURATION_MS`
- `CYCLE_MAX_TASKS`
- `CYCLE_MAX_FAILURE_RATE`
- `CYCLE_CRITICAL_ANOMALY_RESTART_COOLDOWN_MS`
- `CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS`
- `ANOMALY_REPEAT_COOLDOWN_MS`
- `REPLAN_PLANNER_ACTIVE_WINDOW_MS`
- `REPLAN_SKIP_SAME_SIGNATURE`

### 6.7 sandbox 実行

- `SANDBOX_DOCKER_IMAGE`
- `SANDBOX_DOCKER_NETWORK`
- `CLAUDE_AUTH_DIR`
- `CLAUDE_CONFIG_DIR`

---

## 7. 認証・アクセス制御の実務注意

- system 制御系は `api-key` / `bearer` が基本
- ローカル開発では `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL` の値で挙動が変わる
  - 厳密運用する場合は `false` を明示
- GitHub CLI モード（`gh`）を使う場合は `gh auth login` 済みであること

---

## 8. 最低限の運用セット

1. Repo 設定 (`REPO_MODE`, `REPO_URL` または local path)
2. GitHub 設定 (`GITHUB_AUTH_MODE`, owner/repo, 必要なら token)
3. LLM 設定 (`LLM_EXECUTOR`, model, provider key)
4. 実行数 (`WORKER_COUNT`, `JUDGE_COUNT`, `PLANNER_COUNT=1`)
5. 回復設定（retry / cooldown / auto restart）

より詳細な運用は `docs/operations.md` を参照してください。

---

## 9. 設定変更の影響マップ（運用目安）

設定は「どのプロセスが読むか」で影響範囲が決まります。  
特に env-only 設定は、対象プロセスの再起動まで反映されません。

| 設定カテゴリ | 主なキー | 影響コンポーネント | 反映タイミングの目安 |
| --- | --- | --- | --- |
| リポジトリ/GitHub | `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`, `GITHUB_*` | API preflight, Planner, Dispatcher, Worker, Judge | 対象プロセス再起動後 |
| 実行環境/起動 | `EXECUTION_ENVIRONMENT`, `SANDBOX_DOCKER_*` | API process manager, Dispatcher launcher, sandbox worker | Dispatcher 再起動後（新規 task から） |
| Planner | `PLANNER_*`, `AUTO_REPLAN`, `REPLAN_*` | Planner, Cycle Manager | Planner / Cycle Manager 再起動後 |
| Dispatcher | `MAX_CONCURRENT_WORKERS`, `POLL_INTERVAL_MS`, `DISPATCH_*` | Dispatcher | Dispatcher 再起動後 |
| Worker 実行設定 | `WORKER_*`, `TESTER_*`, `DOCSER_*`, `LLM_EXECUTOR`, `CLAUDE_CODE_*`, `OPENCODE_*` | Worker/Tester/Docser | 対象 agent 再起動後 |
| Judge | `JUDGE_*`, `JUDGE_MODE` | Judge | Judge 再起動後 |
| リトライ/クリーンアップ | `FAILED_TASK_*`, `BLOCKED_TASK_*`, `STUCK_RUN_TIMEOUT_MS` | Cycle Manager, API tasks retry 表示 | Cycle Manager / API 再起動後 |

### 補足

- DB 管理キーを更新しても、すでに起動中のプロセス環境変数は自動更新されません。
- 影響のあるプロセスだけ `start/stop` で再起動すると、全停止より安全に反映できます。
- 再起動の具体手順は `docs/operations.md` の「設定変更時の安全な再起動手順」を参照してください。
