# 🐯openTiger — Never-stopping autonomous development orchestration

<p align="center">
  <img src="assets/avatar.png" alt="openTiger" width="500" />
</p>

openTiger continuously runs:

1. requirement/issue の取り込み
2. task の計画と配布
3. 実装/テスト/ドキュメント更新の実行
4. review/judgement
5. recovery/retry/rework

all under explicit runtime state transitions.

<p align="center">
  <img src="assets/ui.png" alt="openTiger UI" width="720" />
</p>

## 主要機能

- Requirement -> executable task generation
- Role-based execution (`worker` / `tester` / `docser`)
- PR and local-worktree judgement (`judge`)
- Recovery-first operation (`quota_wait`, `awaiting_judge`, `needs_rework`)
- Backlog-first startup (Issue/PR backlog is processed before new planning)
- Dashboard + API for process control, logs, and system config
- Runtime switch between host process and docker sandbox execution

## アーキテクチャ概要

- **API (`@openTiger/api`)**: system/config/control endpoints and dashboard backend
- **Planner**: generates tasks from requirements/issues
- **Dispatcher**: leases and dispatches queued tasks
- **Worker/Tester/Docser**: executes task changes and verification
- **Judge**: evaluates successful runs and drives merge/rework decisions
- **Cycle Manager**: convergence loop, cleanup, retry, and replan trigger
- **PostgreSQL + Redis**: persistent state + queueing

See `docs/architecture.md` for component-level details.

## 前提環境

- Node.js `>=20`
- pnpm `9.x`
- Docker (for local DB/Redis and sandbox execution mode)

## インストール

### 推奨（bootstrap script）

```bash
curl -fsSL https://opentiger.dev/install.sh | bash
```

### 手動（clone してセットアップ）

```bash
git clone git@github.com:Andyyyy64/openTiger.git
cd openTiger
pnpm run setup
```

## クイックスタート

```bash
pnpm run up
```

`pnpm run up` performs:

- monorepo build
- `postgres` / `redis` startup via docker compose
- DB schema push
- runtime hatch disarm
- DB config export to `.env`
- API + Dashboard dev startup

## 初回チェックリスト

1. GitHub CLI を認証（default auth mode）:

   ```bash
   gh auth login
   ```

2. Claude Code executor を使う場合は host 側で認証:

   ```bash
   claude /login
   ```

3. Dashboard を開く:
   - Dashboard: `http://localhost:5190`
   - API: `http://localhost:4301`
4. Start ページで requirement を入力して実行
   - default canonical requirement path: `docs/requirement.md`
5. 進行状況を監視:
   - `tasks`
   - `runs`
   - `judgements`
   - `logs`
6. 状態が停滞した場合:
   - `docs/state-model.md` の一次診断から着手
   - `docs/operations.md` の runbook で詳細確認

### 共通逆引き導線（状態語彙 -> 遷移 -> 担当 -> 実装）

- API で異常を見つけた場合:
  - `docs/api-reference.md` の「2.2 API 起点の逆引き（状態語彙 -> 遷移 -> 担当 -> 実装）」
- 状態語彙から遷移を追う場合:
  - `docs/state-model.md` -> `docs/flow.md`
- 担当 agent と実装ファイルまで追う場合:
  - `docs/agent/README.md` の「実装追跡の最短ルート」

## 起動と実行時挙動

- Planner is started only when backlog gates are clear.
- Existing local/Issue/PR backlog is always prioritized.
- Runtime convergence order:
  - `local backlog > 0`: continue execution
  - `local backlog == 0`: sync Issue backlog via preflight
  - `Issue backlog == 0`: evaluate planner replan

Details: `docs/startup-patterns.md`, `docs/flow.md`

## ドキュメントマップ

まずは用途別索引から確認してください:

- `docs/README.md`
  - reader lane（初見/運用/実装追従）を含みます

導入時の推奨順:

- `docs/getting-started.md`
- `docs/architecture.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/operations.md`
- `docs/api-reference.md` の「2.2 API 起点の逆引き（状態語彙 -> 遷移 -> 担当 -> 実装）」

実行時挙動の参照:

- `docs/state-model.md`
- `docs/flow.md`
- `docs/startup-patterns.md`
- `docs/mode.md`
- `docs/execution-mode.md`
- `docs/policy-recovery.md`
- `docs/verification.md`

agent 仕様の参照:

- `docs/agent/README.md` (role comparison)
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

設計方針:

- `docs/nonhumanoriented.md`

## 認証とアクセス制御の注意

- API authentication middleware supports:
  - `X-API-Key` (`API_KEYS`)
  - `Authorization: Bearer <token>` (`API_SECRET` or custom validator)
- `/health` と GitHub webhook endpoint（`/webhook/github`、prefix 構成時は `/api/webhook/github`）は auth-skipped.
- System-control (`/system/*`, `POST /logs/clear`) access is checked by `canControlSystem()`:
  - `api-key` / `bearer`: always allowed
  - local insecure fallback: allowed unless `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL=false`

## OSS としてのスコープ

openTiger is optimized for long-running autonomous repository workflows with explicit recovery paths.  
It does **not** guarantee one-shot success under all external conditions, but it is designed to avoid silent stalls and continuously converge by switching recovery strategy.
