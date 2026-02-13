# 実行環境ガイド

このドキュメントは、`EXECUTION_ENVIRONMENT` が実行時挙動にどう影響するかと、  
sandbox モードで `claude_code` を安全に運用するための前提を説明します。

関連:

- `docs/mode.md`
- `docs/config.md`
- `docs/operations.md`
- `docs/agent/dispatcher.md`

## 1. 概要

`EXECUTION_ENVIRONMENT` は `system_config` のキーで、次の2値を取ります。

- `host`
- `sandbox`

内部では次の launch mode に対応します。

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

## 2. 利用箇所

- Dashboard の System ページ（`Execution_Environment` セレクタ）
- process manager の start フロー（`/system/processes/:name/start`）
- Dispatcher の worker launcher
- Claude 認証確認 API（`/system/claude/auth`）

## 3. モード別の実行挙動

### 3.1 `host`

- Worker/Tester/Docser は host process として起動します。
- Claude 認証確認は host 側で実行されます（`claude -p ...`）。
- ローカル開発での高速反復に向いています。

### 3.2 `sandbox`

- task 実行は Docker container 内で行われます。
- host 側 Worker/Tester/Docser の起動はスキップされます。
- Claude 認証確認は container 側で実行されます（`docker run ... claude -p ...`）。
- 分離性を高く保ちたい運用に向いています。

## 4. sandbox の前提

### 4.1 Worker image

sandbox 用 worker image には次の CLI が必要です。

- `opencode-ai`
- `@anthropic-ai/claude-code`

既定 image:

- `openTiger/worker:latest`

別 tag を使う場合は次を設定します。

- `SANDBOX_DOCKER_IMAGE=<your-image>`

### 4.2 Docker network

既定 network:

- `bridge`

必要に応じて次で上書きします。

- `SANDBOX_DOCKER_NETWORK=<your-network>`

## 5. sandbox での Claude 認証

host 側の login 状態が使える場合、`ANTHROPIC_API_KEY` なしでも `claude_code` を実行できます。

マウントされる認証ディレクトリ（read-only）:

- `~/.claude` -> `/home/worker/.claude`
- `~/.config/claude` -> `/home/worker/.config/claude`

必要に応じた上書き設定:

- `CLAUDE_AUTH_DIR`
- `CLAUDE_CONFIG_DIR`

推奨手順:

1. host で `claude /login` を実行
2. `EXECUTION_ENVIRONMENT=sandbox` を設定
3. dispatcher を起動して task を実行

認証マウントが見つからず `ANTHROPIC_API_KEY` も未設定の場合、dispatcher は warning を出します。

## 6. sandbox からの DB/Redis 接続

dispatcher は sandbox container 起動時に loopback 宛先を次へ書き換えます。

- `localhost` / `127.0.0.1` / `::1` -> `host.docker.internal`

これにより、container 内 worker から host 側サービスへ接続できます。

## 7. Claude Auth Check API

endpoint:

- `GET /system/claude/auth`

query（任意）:

- `environment=host|sandbox`

挙動:

- query 省略時は現在の `EXECUTION_ENVIRONMENT` を使います。
- `available`, `authenticated`, `checkedAt`, `executionEnvironment` を返します。
- sandbox では典型エラーを分類します。
  - Docker daemon unavailable
  - sandbox image missing
  - `claude` CLI missing in image
  - authentication required (`/login`)

アクセス注意:

- この endpoint は system-control API です。
- `api-key` / `bearer` は許可されます。
- ローカル運用では `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL !== "false"` の間は許可されます。

## 8. トラブルシューティング

### `authenticated=false` になる場合（sandbox）

- host 側で `claude /login` 済みか確認
- 認証ディレクトリが存在し読み取り可能か確認
- マウント先が runtime policy で遮断されていないか確認

### `image unavailable` が出る

- `SANDBOX_DOCKER_IMAGE` で指定した image を build/pull する
- 既定 tag とローカル/CI の運用方針を揃える

### デーモンエラー（Docker daemon error）が出る場合

- Docker Desktop または `dockerd` を起動する
- `docker` 実行権限を確認する

### コンテナ内で CLI が見つからない場合

- `ops/docker/worker.Dockerfile` から worker image を再 build する
