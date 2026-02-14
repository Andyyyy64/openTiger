# Plugin Development Guide

openTiger supports feature expansion as plugins that reuse the same runtime model:

- `tasks`
- `runs`
- `artifacts`
- `events`
- Dispatcher/Worker/Judge/Cycle Manager convergence loop

TigerResearch is the reference plugin.

## 1. Design Rules (for OSS plugin authors)

1. Keep orchestration contracts unchanged:
   - enqueue work in `tasks`
   - execute via worker agents
   - persist execution history in `runs/artifacts`
2. Add plugin-specific domain schema outside core `packages/db/src/schema.ts`
3. Register plugin surfaces via registries, not hardcoded conditionals
4. Keep plugin task kind explicit (`tasks.kind = <plugin-kind>`)
5. Ensure recoverability (`blocked`, `retry`, `needs_rework`) within existing loops

## 2. Registry Points

### API registry

- `apps/api/src/plugins/index.ts`
- `apps/api/src/plugins/types.ts`
- `apps/api/src/plugins/tiger-research.ts`

Mount plugin routes under:

- `/plugins/<plugin-id>/...`

TigerResearch keeps `/research/...` as backward-compatible alias.

### Dashboard registry

- `apps/dashboard/src/plugins/registry.ts`
- `apps/dashboard/src/plugins/types.ts`
- `apps/dashboard/src/plugins/tiger-research.tsx`

The sidebar now exposes a `plugins` section and plugin-specific pages.

### Worker task-kind registry

- `apps/worker/src/plugins/index.ts`
- `apps/worker/src/plugins/types.ts`
- `apps/worker/src/plugins/tiger-research.ts`

`worker-runner.ts` resolves handler by `task.kind` and dispatches to plugin code path.

### Cycle Manager monitor plugin registry

- `apps/cycle-manager/src/plugins/index.ts`
- `apps/cycle-manager/src/plugins/types.ts`
- `apps/cycle-manager/src/plugins/tiger-research.ts`

Plugin monitor ticks are executed each loop without hardcoding in `loops.ts`.

## 3. Plugin Schema Placement

Core schema (`packages/db/src/schema.ts`) now excludes TigerResearch domain tables.

TigerResearch plugin schema lives in:

- `packages/db/src/plugins/tiger-research.ts`

and is re-exported through:

- `@openTiger/db/schema` (compatibility names: `researchJobs`, `researchClaims`, ...)

## 4. Minimal Checklist for New Plugin

1. Create plugin domain schema (`packages/db/src/plugins/<plugin>.ts`)
2. Add API route module and registry registration
3. Add dashboard plugin entry and routes
4. Add worker task-kind handler for plugin execution
5. Optionally add cycle/judge/planner hooks
6. Add docs page under `docs/`

## 5. TigerResearch as Reference

See:

- `docs/research.md`
- `apps/api/src/plugins/tiger-research.ts`
- `apps/dashboard/src/plugins/tiger-research.tsx`
- `apps/worker/src/plugins/tiger-research.ts`
- `packages/db/src/plugins/tiger-research.ts`
