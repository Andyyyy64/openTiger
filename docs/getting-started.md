# Getting Started

このガイドは、openTiger を初回起動して最初の自律実行を開始するまでの最短手順です。

関連:

- `docs/architecture.md`
- `docs/config.md`
- `docs/api-reference.md`
- `docs/operations.md`
- `docs/agent/README.md`

## 1. 前提

- Node.js `>=20`
- pnpm `9.x`
- Docker
- GitHub CLI (`gh`) 推奨

Claude Code executor を使う場合は `claude` CLI も必要です。

## 2. セットアップ

```bash
pnpm run setup
```

## 3. 認証（初回のみ）

### GitHub

デフォルトは `GITHUB_AUTH_MODE=gh` です。

```bash
gh auth login
```

`token` モードを使う場合は、System Config で `GITHUB_TOKEN` を設定してください。

### Claude Code（`LLM_EXECUTOR=claude_code` の場合）

```bash
claude /login
```

## 4. 起動

```bash
pnpm run up
```

このコマンドは次を実行します。

- build
- `postgres` / `redis` 起動
- DB schema push
- runtime hatch disarm
- DB設定を `.env` へ export
- API/Dashboard 起動

## 5. Dashboard にアクセス

- Dashboard: `http://localhost:5190`
- API: `http://localhost:4301`

## 6. Start ページで最初の実行を開始

1. requirement を入力
2. `EXECUTE RUN` を実行
3. preflight 推奨に従って process を起動

重要:

- backlog（Issue/PR/ローカルタスク）がある場合、Planner は意図的にスキップされます。
- Planner は backlog が空のときのみ開始されます。

## 7. 進行状況の確認

- `tasks`: タスク状態
- `runs`: 実行結果・ログ
- `judgements`: Judge 評価
- `logs`: プロセスログ集約

## 8. よくある初期トラブル

### GitHub repo 未設定

- Start ページの repo manager から既存 repo を選択、または新規作成
- `REPO_MODE=git` の場合は `REPO_URL` と `GITHUB_OWNER/REPO` が必要

### Claude auth warning

- host 実行: `claude /login` を再実行
- sandbox 実行: host の認証ディレクトリがマウントされることを確認

### preflight で Planner が起動しない

- backlog 優先の正常動作です
- Issue/PR/ローカル backlog が解消されると再計画対象になります
