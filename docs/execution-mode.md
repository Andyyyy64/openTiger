# Execution Environment Guide

This document explains how `EXECUTION_ENVIRONMENT` controls runtime behavior and how to run `claude_code` safely in sandbox mode.

## 1. Overview

`EXECUTION_ENVIRONMENT` is a `system_config` key with two values:

- `host`
- `sandbox`

It maps to launch mode internally:

- `host` -> `LAUNCH_MODE=process`
- `sandbox` -> `LAUNCH_MODE=docker`

## 2. Where It Is Used

- Dashboard `system` page (`Execution_Environment` selector)
- Process manager start flow (`/system/processes/:name/start`)
- Dispatcher worker launcher
- Claude authentication check API (`/system/claude/auth`)

## 3. Runtime Behavior By Mode

### 3.1 `host`

- Worker/Tester/Docser run as host processes.
- Claude auth check runs on host (`claude -p ...`).
- Best for fastest local turnaround and simple setup.

### 3.2 `sandbox`

- Task execution runs in Docker containers.
- Host Worker/Tester/Docser process start is skipped.
- Claude auth check runs in container (`docker run ... claude -p ...`).
- Best for stronger process isolation.

## 4. Sandbox Requirements

### 4.1 Worker Image

The sandbox worker image must include both CLIs:

- `opencode-ai`
- `@anthropic-ai/claude-code`

Default image name:

- `openTiger/worker:latest`

If you use a different tag, set:

- `SANDBOX_DOCKER_IMAGE=<your-image>`

### 4.2 Docker Network

Default network:

- `bridge`

Optional override:

- `SANDBOX_DOCKER_NETWORK=<your-network>`

## 5. Claude Subscription Authentication in Sandbox

You can run `claude_code` without `ANTHROPIC_API_KEY` when host login state is available.

Mounted auth paths (read-only):

- `~/.claude` -> `/home/worker/.claude`
- `~/.config/claude` -> `/home/worker/.config/claude`

Optional explicit overrides:

- `CLAUDE_AUTH_DIR`
- `CLAUDE_CONFIG_DIR`

Recommended flow:

1. Run `claude /login` on host.
2. Set `EXECUTION_ENVIRONMENT=sandbox`.
3. Start dispatcher and run tasks from dashboard.

If no auth mount is found and no `ANTHROPIC_API_KEY` is set, dispatcher logs a warning.

## 6. DB and Redis Access From Sandbox

When launching sandbox containers, dispatcher rewrites local endpoints:

- `localhost` / `127.0.0.1` / `::1` -> `host.docker.internal`

This allows containerized workers to reach host services when URLs point to local loopback.

## 7. Claude Auth Check API

Endpoint:

- `GET /system/claude/auth`

Optional query:

- `environment=host|sandbox`

Behavior:

- If query is omitted, server uses current `EXECUTION_ENVIRONMENT`.
- Returns `available`, `authenticated`, `checkedAt`, and `executionEnvironment`.
- In sandbox mode, common runtime failures are classified:
  - Docker daemon unavailable
  - sandbox image missing
  - `claude` CLI missing in image
  - authentication required (`/login`)

## 8. Troubleshooting

### `authenticated=false` in sandbox

- Ensure host login exists: run `claude /login`.
- Ensure auth directories exist and are readable.
- Ensure mounted paths are not blocked by runtime policy.

### "image unavailable" message

- Build or pull the image configured in `SANDBOX_DOCKER_IMAGE`.
- Keep default tag aligned with your local/CI image strategy.

### Docker daemon error

- Start Docker Desktop or `dockerd`.
- Verify user permission to run `docker`.

### CLI missing in container

- Rebuild worker image from `ops/docker/worker.Dockerfile`.
