# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openTiger is an autonomous coding orchestration system. It continuously ingests requirements/issues, plans tasks, dispatches them to execution agents, judges results, and handles recovery/retry — all under explicit state transitions. The system is **recovery-first**: non-stalling convergence matters more than one-shot success.

## Commands

```bash
# Full bootstrap (install + docker + db + dev servers)
pnpm run setup && pnpm run up

# Quality checks (run before any PR)
pnpm run check          # lint + typecheck
pnpm run check:all      # lint + format + typecheck + build
pnpm test               # all tests
pnpm test:watch         # watch mode

# Single package test
pnpm --filter @openTiger/worker test
pnpm --filter @openTiger/core test

# Linting and formatting
pnpm lint               # oxlint
pnpm format             # oxfmt
pnpm typecheck          # tsc --noEmit

# CI parity (all must pass)
pnpm build && pnpm lint:ci && pnpm typecheck && pnpm test

# Database (Drizzle ORM)
pnpm db:push            # push schema (idempotent)
pnpm db:generate        # generate migrations
pnpm db:migrate         # apply migrations
pnpm db:studio          # database GUI

# Dev servers
pnpm ui                 # dashboard only (localhost:5190)
pnpm server             # API only (localhost:4301)
pnpm dev                # planner + dispatcher + 4 workers
pnpm dev:full           # add tester + docser
```

Do **not** assume `pnpm start`, `pnpm preview`, `pnpm migrate`, or `pnpm generate` exist at root.

## Architecture

**Execution loop:**
Planner → Dispatcher → Worker/Tester/Docser → Judge → Cycle Manager → (loop)

**Monorepo layout:**

- `apps/api` — REST API + dashboard backend (Hono)
- `apps/planner` — task generation from requirements/issues
- `apps/dispatcher` — queue lease scheduler
- `apps/worker` — execution engine (worker/tester/docser roles)
- `apps/judge` — PR review, approve/rework decisions
- `apps/cycle-manager` — convergence, retry, cleanup loops
- `apps/dashboard` — React UI (Vite)
- `packages/core` — domain primitives, failure codes, utilities
- `packages/db` — PostgreSQL schema (Drizzle ORM)
- `packages/llm` — LLM executor abstractions
- `packages/vcs` — Git/GitHub operations
- `packages/queue` — BullMQ queue abstractions
- `packages/policies` — default recovery/auto-merge policies
- `packages/plugin-sdk` — plugin platform contract
- `plugins/tiger-research` — reference plugin (planner-first research)

**Stack:** TypeScript, Node.js >=22.12, pnpm 9.x, Turbo, PostgreSQL, Redis/BullMQ, Vitest, oxlint/oxfmt.

## Canonical Vocabulary

Always use these exact terms when editing state or logic:

- **Task status:** `queued`, `running`, `done`, `failed`, `blocked`, `cancelled`
- **Block reasons:** `awaiting_judge`, `quota_wait`, `needs_rework`, `issue_linking`
- **Task kinds:** `code`, `research`
- **Modes:** `REPO_MODE` (`github`/`local-git`/`direct`), `JUDGE_MODE` (`github`/`local-git`/`direct`/`auto`), `EXECUTION_ENVIRONMENT` (`host`/`sandbox`)

## Key Design Rules

- **Recovery-first:** Convert failures into explicit next states. Never leave work in implicit halt.
- **Backlog-first startup:** Consume existing local/issue/PR backlog before generating new tasks. Planner starts only when `R && !I && !P && !L`.
- **Idempotent control points:** Preserve lease + runtime lock + run-claim semantics. Judge uses `judgedAt`/`judgementVersion` to prevent double-review.
- **Ownership boundaries are strict:** Planner plans, Dispatcher assigns, Worker executes, Judge evaluates, Cycle Manager converges. Do not move cross-layer orchestration into execution code.
- **Plugin over hardcoding:** Prefer plugin/registry extension over feature branching in core loops.

## Code Conventions

- State transitions must be atomic: update `status`, `blockReason`, and `updatedAt` together. Follow `finalizeTaskState` pattern in `apps/worker/src/worker-runner-state.ts`.
- Use `FAILURE_CODE` constants from `@openTiger/core` for failure reasons.
- Classify failures with `classifyFailure(errorMessage, errorMeta)` — keep classifiers deterministic and side-effect free.
- Retry count: always increment explicitly with `(task.retryCount ?? 0) + 1`.
- Repeated failure signatures must switch strategy (`needs_rework`, autofix, or split rework), not retry forever.
- Verification commands must be spawn-safe: no `$()`, pipes, `&&`, `||`, `;`, redirections, or backticks in command definitions.
- Emit structured events for transitions: `recordEvent({ type, entityType, entityId, payload })`.
- Use component-prefixed logs: `[Worker]`, `[Judge]`, `[Cleanup]`, etc.

## Testing

- Framework: Vitest 3.x with `globals: true`
- Tests live in each app/package's `test/` directory
- For changed retry/classification/branching logic, add tests covering success path and guard/fallback path
- Run targeted tests for modified apps, then broader `pnpm test` if changes cross packages

## Documentation Update Contract

When changing any of these, update the corresponding docs in the same PR:

- State transitions or block reason semantics → `docs/state-model.md`, `docs/flow.md`
- Startup/replan gates → `docs/startup-patterns.md`
- Retry/recovery strategy → `docs/operations.md`
- Agent ownership → `docs/agent/*.md`
- API contracts → `docs/api-reference.md`

## Instruction Precedence

1. Explicit user prompt
2. Nearest `AGENTS.md` in directory tree for file being edited
3. Root `AGENTS.md`
4. Other repo docs (`README.md`, `docs/*`, `CONTRIBUTING.md`)
