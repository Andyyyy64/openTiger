# Execution Environment Guide

This document explains how `EXECUTION_ENVIRONMENT` affects runtime behavior and
the prerequisites for running `claude_code` / `codex` safely in sandbox mode.

Related:

- `docs/mode.md`
- `docs/config.md`
- `docs/state-model.md`
- `docs/flow.md`
- `docs/operations.md`
- `docs/agent/dispatcher.md`

### Common Lookup Path (state vocabulary -> transition -> owner -> implementation, when entering from execution env config)

When tracing incidents from host/sandbox config, follow: state vocabulary -> transition -> owner -> implementation.

1. `docs/state-model.md` (state vocabulary)
2. `docs/flow.md` (runtime transitions and recovery)
3. `docs/operations.md` (API procedures and operation shortcuts)
4. `docs/agent/README.md` (owning agent and implementation tracing)

## 1. Overview

`EXECUTION_ENVIRONMENT` is a `system_config` key with two values:

- `host`
- `sandbox`

Internally it maps to launch mode:

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

## 2. Where It Is Used

- Dashboard System page (`Execution_Environment` selector)
- Process manager startup flow (`/system/processes/:name/start`)
- Dispatcher worker launch
- Claude auth check API (`/system/claude/auth`)
- Codex auth check API (`/system/codex/auth`)

## 3. Behavior by Mode

### 3.1 `host`

- Worker/Tester/Docser run as host processes
- Claude auth check runs on host (`claude -p ...`)
- Codex auth check runs on host (`codex login status`)
- Suited for fast local development iteration

### 3.2 `sandbox`

- Task execution runs inside Docker container
- Host Worker/Tester/Docser startup is skipped
- Claude auth check runs in container (`docker run ... claude -p ...`)
- Codex auth check runs in container (`docker run ... codex login status`)
- Suited for higher isolation requirements

## 4. Sandbox Prerequisites

### 4.1 Worker Image

Sandbox worker image must include:

- `opencode-ai`
- `@anthropic-ai/claude-code`
- `@openai/codex`

Default image:

- `openTiger/worker:latest`

To use a different tag:

- `SANDBOX_DOCKER_IMAGE=<your-image>`

### 4.2 Docker Network

Default network:

- `bridge`

Override if needed:

- `SANDBOX_DOCKER_NETWORK=<your-network>`

## 5. Executor Auth in Sandbox

### 5.1 Claude

When host login state is usable, `claude_code` can run without `ANTHROPIC_API_KEY`.

Mounted auth dirs (read-only):

- `~/.claude` -> `/home/worker/.claude`
- `~/.config/claude` -> `/home/worker/.config/claude`

Override if needed:

- `CLAUDE_AUTH_DIR`
- `CLAUDE_CONFIG_DIR`

Recommended steps:

1. Run `claude /login` on host
2. Set `EXECUTION_ENVIRONMENT=sandbox`
3. Start dispatcher and run tasks

### 5.2 Codex

Codex can run with either login state or API key mode (`OPENAI_API_KEY` / `CODEX_API_KEY`).

Mounted auth dir (read-only):

- `~/.codex` -> `/home/worker/.codex`

Override if needed:

- `CODEX_AUTH_DIR`

Recommended steps:

1. Run `codex login` on host (or configure API key mode)
2. Set `EXECUTION_ENVIRONMENT=sandbox`
3. Start dispatcher and run tasks

If auth mount is not found and key mode is not configured, dispatcher logs a warning.

## 6. DB/Redis Connectivity from Sandbox

Dispatcher rewrites loopback destinations at sandbox container start:

- `localhost` / `127.0.0.1` / `::1` -> `host.docker.internal`

This allows container workers to reach host services.

## 7. Auth Check APIs

Endpoints:

- `GET /system/claude/auth`
- `GET /system/codex/auth`

Query (optional):

- `environment=host|sandbox`

Behavior:

- Uses current `EXECUTION_ENVIRONMENT` when query omitted
- Returns `available`, `authenticated`, `checkedAt`, `executionEnvironment`
- For sandbox, classifies typical errors:
  - Docker daemon unavailable
  - Sandbox image missing
  - CLI missing in image
  - Authentication required

Access:

- This is a system-control API
- `api-key` / `bearer` allowed
- Local operation: allowed when `OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL !== "false"`

## 8. Troubleshooting

### `authenticated=false` (sandbox)

- Claude: confirm `claude /login` on host and auth mount
- Codex: confirm `codex login` or key mode, and `~/.codex` mount when using login mode

### `image unavailable`

- Build/pull image specified by `SANDBOX_DOCKER_IMAGE`
- Align default tag with local/CI policy

### Docker daemon error

- Start Docker Desktop or `dockerd`
- Verify `docker` execution permissions

### CLI not found in container

- Rebuild worker image from `ops/docker/worker.Dockerfile`
