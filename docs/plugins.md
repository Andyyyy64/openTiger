# Plugin Platform Guide (Manifest v1)

openTiger plugin support is standardized around a single contract: `PluginManifestV1`.

This document defines the platform contract and migration-safe behavior for:

- API route exposure
- planner/dispatcher/worker/judge/cycle hooks
- dashboard route/nav exposure
- plugin-scoped database migration
- compatibility and enable/disable behavior

TigerResearch is the reference implementation.

## 1. Platform Goals

1. Keep core orchestration stable while allowing plugin specialization.
2. Use one manifest contract across all runtime agents.
3. Let operators enable/disable plugins without code edits.
4. Keep failure isolation explicit (`incompatible`, `error`, `disabled`) and observable.
5. Preserve recoverability-first task lifecycle behavior.

## 2. Plugin Packaging Model

Plugins are first-party monorepo packages under `plugins/<plugin-id>/`.

Each plugin package exports one manifest entrypoint:

- `plugins/<plugin-id>/index.ts`

The core loader (`packages/plugin-sdk`) discovers, validates, and activates plugins according to `ENABLED_PLUGINS`.

## 3. PluginManifestV1 Contract

Manifest fields:

- Required
  - `id: string` (stable plugin identifier)
  - `version: string` (plugin package version)
  - `pluginApiVersion: string` (platform contract version, e.g. `"1"`)
  - `taskKinds: string[]` (kinds owned/handled by the plugin)
  - `lanes: string[]` (dispatcher lanes contributed by the plugin)
- Optional
  - `requires?: string[]` (plugin dependencies by `id`)
  - `api?`
  - `planner?`
  - `dispatcher?`
  - `worker?`
  - `judge?`
  - `cycleManager?`
  - `dashboard?`
  - `db?`

### 3.1 Compatibility Policy

- Loader compares `pluginApiVersion` with core-supported version.
- If incompatible:
  - plugin status becomes `incompatible`
  - plugin is skipped (not loaded)
  - core runtime continues
  - structured logs and `/plugins` response include reason

### 3.2 Activation Policy

- `ENABLED_PLUGINS` is a CSV list (example: `tiger-research,slack-triage`).
- Plugins not listed are treated as `disabled`.
- Activation changes are applied on process restart.

## 4. Hook Contracts

## 4.1 API Hook

- Registers all plugin routes under `/plugins/<plugin-id>/*`.
- Legacy alias routes (for example `/research/*`) are not part of the v1 contract.

## 4.2 Planner Hook

Planner hook owns plugin-specific decomposition while preserving planner responsibility boundaries.

Canonical shape:

- `planPluginJob(input) -> { tasks, domainUpdates, warnings }`

Expected behavior:

- Read plugin domain state
- Produce `tasks` with valid `kind/lane` registered by manifest
- Return deterministic domain updates (if any)
- Never embed cross-agent orchestration decisions in planner hook

## 4.3 Dispatcher Hook

- Registers additional lane semantics and lane selection metadata.
- Dispatcher keeps lease/idempotency ownership.

## 4.4 Worker Hook

- Resolves plugin task handler by `task.kind`.
- Executes plugin path without forcing git pipeline usage.

## 4.5 Judge Hook

Judge hook evaluates plugin outputs and returns verdict inputs to existing task transitions.

Canonical shape:

- `collectPendingTargets() -> Target[]`
- `evaluateTarget(target) -> EvaluationResult`
- `applyVerdict(result) -> DomainUpdate`

Judge remains the owner of judgement idempotency and rework transitions.

## 4.6 Cycle Manager Hook

- Provides periodic plugin monitor/orchestration tick.
- Must be safe and idempotent across repeated loop executions.

## 4.7 Dashboard Hook

- Provides plugin routes and nav entries.
- Discovery uses `import.meta.glob` at build time.
- Enabling/disabling existing plugins can be toggled at runtime startup.
- Adding a new plugin package requires dashboard rebuild because route modules must exist at build time.

## 4.8 DB Hook

Plugin DB integration is migration-based, not schema hardcoding in core.

Expected manifest db metadata:

- plugin migration directory location
- optional schema exports used by plugin package

## 5. DB Migration Order and Safety

Global migration order:

1. Core migrations
2. Plugin migrations in topological order by `requires`

Rules:

- Dependency cycle in `requires` is a hard failure.
- Missing dependency plugin is a hard failure for dependent plugin.
- Migration execution is idempotent and persisted in migration state.
- Plugin migration failure does not silently continue; error is explicit and actionable.

## 6. Runtime Introspection

`GET /plugins` returns plugin inventory including status:

- `enabled`
- `disabled`
- `incompatible`
- `error`

Response includes at least:

- `id`
- `version`
- `pluginApiVersion`
- `status`
- `capabilities`
- `reason` (for non-enabled states)

## 7. Minimal Authoring Checklist

1. Create `plugins/<id>/index.ts` with `PluginManifestV1`.
2. Declare `taskKinds`, `lanes`, and optional `requires`.
3. Implement required hooks for target behavior.
4. Add plugin-scoped DB migrations if domain tables are needed.
5. Register plugin in loader discovery map.
6. Enable plugin via `ENABLED_PLUGINS`.
7. Run `pnpm run plugin:validate` and `pnpm run check`.
8. Add plugin docs and operational notes.

## 8. TigerResearch Reference

See:

- [research](research.md)
- `plugins/tiger-research/` (manifest + hooks)
