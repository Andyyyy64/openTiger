# AGENTS.md

Comprehensive operating guide for coding agents working in this repository.

This file is intentionally detailed and agent-oriented.
Use it as the first reference before changing code.

## Agent Guidelines

Always prefer simplicity over pathological correctness. YAGNI, KISS, DRY. No backward-compat shims or fallback paths unless they come free without adding cyclomatic complexity.

## 1. Scope and Intent

- This repository is `openTiger`, an autonomous coding orchestration system.
- The system is state-driven and recovery-first.
- The primary goal is non-stalling convergence, not guaranteed one-shot success.
- Coding agents must preserve runtime safety, traceability, and explicit state transitions.
- Source code is the final source of truth; docs must be kept aligned with behavior changes.

## 2. Instruction Precedence

When instructions conflict, resolve in this order:

1. Explicit user prompt in the current chat/session.
2. The nearest `AGENTS.md` in the directory tree for the file being edited.
3. This root `AGENTS.md`.
4. Other repository docs (`README.md`, `docs/*`, `CONTRIBUTING.md`).

Notes:

- If nested `AGENTS.md` files are added later, nearest-file wins.
- Keep local changes consistent with both user intent and nearest agent guidance.

## 3. Project Snapshot

- Monorepo package manager: `pnpm` (workspace).
- Build/task orchestrator: `turbo`.
- Runtime stack:
  - API service
  - Planner
  - Dispatcher
  - Worker/Tester/Docser
  - Judge
  - Cycle Manager
- Persistent data:
  - PostgreSQL (primary state tables)
  - Redis/BullMQ (queue/coordination)
- UI:
  - Dashboard (`@openTiger/dashboard`)

## 4. Architecture at a Glance

Execution loop (high level):

1. Planner generates tasks from requirement/issues.
2. Dispatcher leases and dispatches queued tasks.
3. Worker/Tester/Docser execute and verify.
4. Judge evaluates successful runs and decides approve/rework paths.
5. Cycle Manager performs convergence, cleanup, retry, and replan control.

Core design principles:

- Recovery-first over first-attempt success.
- Backlog-first startup and runtime ordering.
- Explicit blocked reasons for machine-recoverable flow.
- Idempotent control points (lease, runtime lock, run claim).
- Event-driven recovery switching for repeated failures.

## 5. Repository Map

Top-level directories with high relevance:

- `apps/api`: system control APIs, routes, middleware, config bridge.
- `apps/planner`: task planning, decomposition, policy application.
- `apps/dispatcher`: lease and dispatch scheduler.
- `apps/worker`: execution engine, verification, commit/PR flow, task role runtime.
- `apps/judge`: judgement loops, review evaluation, autofix/retry path.
- `apps/cycle-manager`: retry/requeue/cleanup/convergence loops.
- `apps/dashboard`: operational UI.
- `packages/core`: domain primitives, failure codes, shared utilities.
- `packages/db`: DB schema and data-access model.
- `packages/queue`: queue abstractions.
- `packages/vcs`: git/worktree operations.
- `docs`: operational and architectural references.
- `ops`: Docker and operational scripts.
- `scripts`: project utility scripts.

## 6. Mandatory Vocabulary

Use canonical vocabulary when editing state or logic.

Task status:

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

Task block reasons:

- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `issue_linking`

Task kinds:

- `code`
- `research`

Modes:

- `REPO_MODE`: `github`, `local-git`, or `direct`
- `JUDGE_MODE`: `github`, `local-git`, `direct`, or `auto`
- `EXECUTION_ENVIRONMENT`: `host` or `sandbox`

## 7. Environment and Prerequisites

Required tooling:

- Node.js `>=22.12.0`
- `pnpm` `9.x` (workspace package manager)
- Docker (for local postgres/redis and sandbox mode)
- `gh` CLI for GitHub auth flows

Recommended auth setup:

- GitHub: `gh auth login`
- Claude Code executor (if used): `claude /login` on host
- Codex executor (if used): `codex login` or API key env vars

Local URLs (default):

- Dashboard: `http://localhost:5190`
- API: `http://localhost:4301`

## 8. Root Command Reference (Verified)

Install and bootstrap:

- `pnpm run setup`
- `pnpm run up`

Development:

- `pnpm run dev`
- `pnpm run dev:full`
- `pnpm run dev:all`
- `pnpm run ui`
- `pnpm run server`

Quality and verification:

- `pnpm run lint`
- `pnpm run lint:ci`
- `pnpm run typecheck`
- `pnpm run check`
- `pnpm run check:all`
- `pnpm run test`
- `pnpm run test:watch`
- `pnpm run test:coverage`
- `pnpm run format`
- `pnpm run format:check`

Build:

- `pnpm run build`

Database:

- `pnpm run db:generate`
- `pnpm run db:migrate`
- `pnpm run db:push`
- `pnpm run db:studio`

Runtime and logs:

- `pnpm run runtime:hatch:status`
- `pnpm run runtime:hatch:arm`
- `pnpm run runtime:hatch:disarm`
- `pnpm run requeue`
- `pnpm run logs:cycle`
- `pnpm run logs:all`
- `pnpm run logs:all:30m`
- `pnpm run logs:all:latest`

Utilities:

- `pnpm run config:import`
- `pnpm run config:export`
- `pnpm run clean`
- `pnpm run line`

## 9. Commands to Avoid Assuming

Do not assume these root scripts exist:

- `pnpm start`
- `pnpm preview`
- `pnpm migrate`
- `pnpm generate`

Use the verified commands in Section 8 instead.

## 10. Package-Level Commands (Common Patterns)

Most backend apps (`api`, `planner`, `dispatcher`, `judge`, `cycle-manager`, `worker`) provide:

- `dev`
- `build`
- `start`
- `test`
- `test:watch`
- `test:coverage`
- `lint`
- `lint:ci`
- `typecheck`
- `clean`

Worker-specific dev variants:

- `dev`, `dev:2`, `dev:3`, `dev:4`
- `dev:runtime`
- `dev:tester`, `dev:tester:2`
- `dev:docser`

Dashboard-specific:

- `dev`
- `build`
- `check`
- `lint`
- `lint:ci`
- `typecheck`
- `preview`

## 11. Standard Agent Workflow for Code Changes

Use this flow unless the user explicitly requests otherwise:

1. Understand target behavior and affected component ownership.
2. Locate current state/flow semantics in docs and source.
3. Implement minimal, coherent change with explicit state impact.
4. Add or update tests for changed behavior.
5. Run local checks (minimum: `pnpm run check`).
6. Run targeted tests for modified apps, then broader tests if needed.
7. Update docs when state/flow/config/ownership behavior changed.
8. Summarize behavioral impact, verification done, and residual risk.

## 12. Mandatory Verification Policy

After substantive edits:

- Always run `pnpm run check`.
- Prefer targeted app tests:
  - Example: `pnpm --filter @openTiger/worker test`
- If change crosses multiple apps, run broader tests:
  - `pnpm run test`

For CI parity, ensure these pass:

- `pnpm build`
- `pnpm lint:ci`
- `pnpm typecheck`
- `pnpm test`

## 13. Coding Rules for State and Retry Logic

When editing task/run transition behavior:

- Keep updates explicit and auditable.
- Preserve atomicity where current code uses transaction boundaries.
- Update `status`, `blockReason`, and `updatedAt` consistently.
- Keep retry count updates explicit.
- Do not introduce silent fallback states.
- Do not hide failures in logs only; emit structured events when expected.

When editing failure classification:

- Prefer structured failure metadata (`errorMeta`) plus message context.
- Use shared failure-code constants from `@openTiger/core`.
- Keep classifier behavior deterministic and side-effect free.

When editing cooldown/retry:

- Preserve clear cooldown math and next-attempt semantics.
- Keep quota failures as recoverable wait (`quota_wait`), not terminal stop by default.
- Ensure repeated-failure strategies eventually switch path.

## 14. Verification and Command Handling Constraints

Verification command handling is designed for spawn-based execution.
Avoid shell-only constructs in verification command definitions.

Unsupported style to avoid in command definitions:

- `$()`
- pipes (`|`)
- `&&`
- `||`
- `;`
- input/output redirection (`<`, `>`)
- backticks

When adjusting verification behavior:

- Prefer explicit parser/normalizer helpers.
- Keep failure reason to adjustment mapping deterministic.
- Preserve fallback and no-op safety paths.

## 15. Ownership Boundaries (Do Not Blur)

Planner:

- Responsible for planning and decomposition.
- Not responsible for execution runtime and merge operations.
- Plugin logic execution: Delegated to `plugin.planner.handleJob`.

Dispatcher:

- Responsible for selecting queued tasks, lease discipline, assignment.
- Not responsible for judgement or replan policy.
- Plugin lane integration: Resolves `plugin.lanes` from registry.

Worker/Tester/Docser:

- Responsible for task execution and verification.
- Not responsible for global replan decisions.
- Plugin execution: Delegated to `plugin.worker.run`.

Judge:

- Responsible for review/evaluation and approve/rework actions.
- Not responsible for task dispatch.
- Plugin judgement: Delegated to `plugin.judge.evaluateTarget` and `applyVerdict`.

Cycle Manager:

- Responsible for convergence, cleanup, retry/requeue orchestration.
- Not responsible for implementing individual tasks.
- Plugin monitoring: Delegated to `plugin.cycleManager.runMonitorTick`.

## 16. Startup and Runtime Ordering Invariants

Backlog-first behavior is required:

- Existing local/issue/PR backlog is consumed before new planning.
- Planner starts only when backlog gates are clear.

Key startup formula:

- `startPlanner = R && !I && !P && !L`

Runtime convergence pattern:

1. If local backlog exists, continue execution.
2. If local backlog is empty, sync issue backlog via preflight.
3. If issue backlog exists, do not replan.
4. Replan only when local and issue backlog are both empty.

## 17. Mode-Aware Development Rules

Repository mode (`REPO_MODE`):

- `github`: PR-oriented flow, remote operations, branch/PR artifacts.
- `local-git`: local worktree flow, no remote PR requirement.
- `direct`: edit project files in-place, no git required. Single worker, auto-approve judge.

Judge mode (`JUDGE_MODE`):

- `github`: force PR review path.
- `local-git`: force local diff path.
- `direct`: auto-approve mode (no LLM review).
- `auto`: follow repository mode.

Execution environment (`EXECUTION_ENVIRONMENT`):

- `host`: process execution on host.
- `sandbox`: dockerized isolated execution.

When changing mode-dependent logic:

- Keep branch paths explicit and easy to audit.
- Avoid hidden mode fallback that changes behavior silently.
- Keep error messages mode-specific and actionable.

## 18. Observability and Debugging Guide

Primary APIs:

- `GET /system/processes`
- `GET /agents`
- `GET /tasks`
- `GET /runs`
- `GET /judgements`
- `GET /logs/all`

CLI/log shortcuts:

- `pnpm run logs:all`
- `pnpm run logs:all:30m`
- `pnpm run logs:cycle`

Initial incident lookup order:

1. `docs/state-model.md` (vocabulary)
2. `docs/flow.md` (transitions)
3. `docs/operations.md` (procedures)
4. `docs/agent/README.md` (ownership + implementation map)

## 19. Component-Specific Change Guidance

`apps/api`:

- Preserve route/auth/system-control boundaries.
- Keep parsing, validation, and data-fetch logic explicit.
- Avoid introducing side effects in read endpoints.

`apps/planner`:

- Preserve planning gating and backlog interaction assumptions.
- Keep dependency and policy logic deterministic.

`apps/dispatcher`:

- Preserve lease integrity and duplicate-dispatch prevention.
- Keep scheduler recovery and cleanup paths explicit.

`apps/worker`:

- Preserve execution pipeline ordering:
  - `github`/`local-git`: checkout -> branch/worktree -> execute -> verify -> commit -> PR/finish
  - `direct`: snapshot -> execute -> snapshot -> diff -> verify -> artifact -> done
- Keep no-diff/no-commit paths explicit (do not force fake diffs).

`apps/judge`:

- Preserve run-claim idempotency and double-judgement prevention.
- Keep non-approve and merge-conflict escalation logic explicit.

`apps/cycle-manager`:

- Preserve cooldown, retry, and requeue semantics.
- Keep rework suppression/depth limits and anti-loop safeguards.

`apps/dashboard`:

- Keep API client typing and page-level state derivation clear.
- Preserve operational clarity (status/retry visibility is critical).

## 20. Documentation Update Contract

If you change behavior in any of these areas, update docs in the same PR:

- State transitions or blocked reason semantics
- Startup/replan gate conditions
- Retry/requeue/recovery strategy
- Agent ownership boundaries
- Mode behavior (`github`/`local-git`/`direct`, `host`/`sandbox`)
- API contract changes

Primary docs to update when relevant:

- `docs/state-model.md`
- `docs/flow.md`
- `docs/startup-patterns.md`
- `docs/operations.md`
- `docs/architecture.md`
- `docs/agent/*.md`
- `docs/api-reference.md`

## 21. Security and Secrets

Never commit:

- API keys
- Access tokens
- private credentials
- local auth artifacts

Use:

- environment variables
- existing secure config mechanisms (`system_config` / config routes)

Security reporting policy:

- Follow `SECURITY.md`.
- Do not create public issues for vulnerabilities.

## 22. CI Expectations and Local Parity

CI currently validates:

- install (`pnpm install --frozen-lockfile`)
- build (`pnpm build`)
- lint CI (`pnpm lint:ci`)
- typecheck (`pnpm typecheck`)
- test (`pnpm test`)
- coverage generation (`pnpm test:coverage`, non-blocking in CI)

Before opening or updating a PR, at minimum run:

- `pnpm run check`
- relevant app tests for changed areas

Before major refactors, run:

- `pnpm run check:all`
- `pnpm run test`

## 23. Common Anti-Patterns to Avoid

- Silent state changes with no explicit reason.
- Infinite retry loops with no strategy switch.
- Conflating ownership boundaries across planner/dispatcher/worker/judge/cycle-manager.
- Editing mode-sensitive logic without handling all modes.
- Introducing shell-specific verify command syntax into spawn-driven command lists.
- Skipping tests for changed branch/condition paths.
- Changing behavior without updating operational docs.
- Hardcoding one-off logic where plugin/extension hooks exist.
- Calling `loadPlugins()` without a preceding `registerPlugin()` block for static imports.

## 24. Agent Checklist (Quick)

Before coding:

- Confirm component ownership.
- Confirm current state and transition expectations in docs.
- Confirm mode assumptions (`REPO_MODE`, `JUDGE_MODE`, `EXECUTION_ENVIRONMENT`).

During coding:

- Keep transitions explicit.
- Preserve idempotency and anti-duplication safeguards.
- Keep logs/events meaningful for operators.

Before finishing:

- Run `pnpm run check`.
- Run targeted tests for touched components.
- Update docs for behavioral contract changes.
- Summarize what changed, why, and how it was verified.

## 25. Useful References

Project docs index:

- `docs/README.md`

Core design and flow:

- `docs/architecture.md`
- `docs/state-model.md`
- `docs/flow.md`
- `docs/startup-patterns.md`
- `docs/nonhumanoriented.md`

Operations and APIs:

- `docs/operations.md`
- `docs/api-reference.md`
- `docs/config.md`

Mode and execution:

- `docs/mode.md`
- `docs/execution-mode.md`

Recovery and verification:

- `docs/policy-recovery.md`
- `docs/verification.md`
- `docs/verify-recovery.md`
- `docs/verify-recovery-worker.md`
- `docs/verify-recovery-cycle-manager.md`

Agent specs:

- `docs/agent/README.md`
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/docser.md`
- `docs/agent/judge.md`
- `docs/agent/cycle-manager.md`
