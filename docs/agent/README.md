# Agent Specification Index

This page provides a cross-agent index for comparing responsibilities and differences of each openTiger agent.

## Table of Contents

- [1. Agent Comparison Table](#1-agent-comparison-table)
- [2. Role Usage](#2-role-usage)
- [3. Agent Boundaries (What They Don't Do)](#3-agent-boundaries-what-they-dont-do)
- [4. Execution Target Differences (Worker Family)](#4-execution-target-differences-worker-family)
- [5. Model / Instruction File Resolution Order](#5-model--instruction-file-resolution-order)
- [6. Common State Model](#6-common-state-model)
- [7. Detailed Specifications](#7-detailed-specifications)
- [8. Common Misconceptions (Agent Responsibility Triage)](#8-common-misconceptions-agent-responsibility-triage)
- [9. Implementation Reference Map (Source of Truth)](#9-implementation-reference-map-source-of-truth)
- [10. Shortest Route for Implementation Tracing (Code Reading Order)](#10-shortest-route-for-implementation-tracing-code-reading-order)

## 1. Agent Comparison Table

| Agent         | Primary responsibility                             | Primary input                              | Main transitions/output                               | Primary failure behavior                               |
| ------------- | -------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------ |
| Planner       | Generate task plans from requirement/issue         | requirement, backlog, feedback, inspection | Create `tasks`, save plan event                       | Fallback planning, duplicate-plan guard                |
| Dispatcher    | Execution order control and task dispatch          | queued task, leases, agent heartbeat       | `queued -> running`, grant lease, assign agent        | Lease recovery, orphan task recovery, requeue          |
| Worker        | Implementation change + verification + PR creation | task, repo/worktree, commands              | Generate `runs/artifacts`, `awaiting_judge` or `done` | `quota_wait` / `needs_rework` / `failed`               |
| Tester        | Execute test-centric tasks                         | tester-role task                           | Same as Worker (test context)                         | Same as Worker                                         |
| Docser        | Execute documentation sync tasks                   | docser-role task                           | docs update run/artifact                              | doc-safe command constraints, no LLM policy recovery   |
| Judge         | Evaluate successful run and govern                 | run/artifacts, CI/policy/LLM results       | `done` or retry/rework/autofix                        | Circuit breaker, autofix, `awaiting_judge` restoration |
| Cycle Manager | Convergence monitoring, recovery, replan control   | system state, events, anomaly/cost         | cycle update, cleanup, replan trigger                 | Critical anomaly restart, cooldown retry               |

Research path mapping:

- Planner: query decomposition for `researchJobId`
- Dispatcher: parallel claim-level task dispatch (`kind=research`)
- Worker: non-git research execution (`plan/collect/challenge/write`)
- Judge: research quality verdict and `needs_rework` branching
- Cycle Manager: research stage orchestration and targeted rework queueing

Note:

- This comparison table organizes by "responsibility unit."
- `GET /agents` shows `planner/worker/tester/docser/judge`; Dispatcher / Cycle Manager are checked via process management (`GET /system/processes`).

## 2. Role Usage

- **Planner** decides "what to execute."
- **Dispatcher** decides "who executes" and "when to execute."
- **Worker/Tester/Docser** "execute and verify."
- **Judge** decides "approve result or send back for rework."
- **Cycle Manager** maintains "operations that keep converging."

## 3. Agent Boundaries (What They Don't Do)

| Agent                | Out of scope                                         |
| -------------------- | ---------------------------------------------------- |
| Planner              | Task execution, PR merge decisions                   |
| Dispatcher           | Code changes, approve/rework decisions               |
| Worker/Tester/Docser | Global replan decisions, overall convergence control |
| Judge                | Task dispatch, direct file modification execution    |
| Cycle Manager        | Individual task implementation, PR content review    |

## 4. Execution Target Differences (Worker Family)

| Aspect                | Worker                    | Tester                                        | Docser                     |
| --------------------- | ------------------------- | --------------------------------------------- | -------------------------- |
| Primary change target | Implementation code       | Test code                                     | Documentation              |
| Verification commands | Per task/policy           | Per task/policy (test-centric)                | doc-safe command preferred |
| LLM policy recovery   | Can be enabled            | Can be enabled                                | Not executed               |
| Typical tasks         | Feature addition, bug fix | Test addition, flaky verification improvement | docs sync, gap fill        |

Worker / Tester / Docser share the same runtime; behavior is switched by `AGENT_ROLE`.

To avoid duplication when reading:

1. Understand shared runtime in [worker](worker.md)
2. Check differences only in [tester](tester.md) / [docser](docser.md)

## 5. Model / Instruction File Resolution Order

Executor resolution order:

| Role    | Executor config (priority)               |
| ------- | ---------------------------------------- |
| worker  | `WORKER_LLM_EXECUTOR` -> `LLM_EXECUTOR`  |
| tester  | `TESTER_LLM_EXECUTOR` -> `LLM_EXECUTOR`  |
| docser  | `DOCSER_LLM_EXECUTOR` -> `LLM_EXECUTOR`  |
| judge   | `JUDGE_LLM_EXECUTOR` -> `LLM_EXECUTOR`   |
| planner | `PLANNER_LLM_EXECUTOR` -> `LLM_EXECUTOR` |

(`inherit` means "use `LLM_EXECUTOR`")

Fallback:

- If `LLM_EXECUTOR` is missing or unrecognized, the effective default executor is `claude_code`.

| Role   | Model config (priority)            | Instruction file config (priority)                                 |
| ------ | ---------------------------------- | ------------------------------------------------------------------ |
| worker | `WORKER_MODEL` -> `OPENCODE_MODEL` | `WORKER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/base.md`   |
| tester | `TESTER_MODEL` -> `OPENCODE_MODEL` | `TESTER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/tester.md` |
| docser | `DOCSER_MODEL` -> `OPENCODE_MODEL` | `DOCSER_INSTRUCTIONS_PATH` -> `apps/worker/instructions/docser.md` |

When effective executor is `claude_code`, `CLAUDE_CODE_MODEL` takes precedence over role-specific OpenCode models.
When effective executor is `codex`, `CODEX_MODEL` takes precedence over role-specific OpenCode models.

## 6. Common State Model

Task status:

- `queued`
- `running`
- `done`
- `failed`
- `blocked`
- `cancelled`

Blocked reason:

- `awaiting_judge`
- `quota_wait`
- `needs_rework`
- `issue_linking`

## 7. Detailed Specifications

- [planner](planner.md)
- [dispatcher](dispatcher.md)
- [worker](worker.md)
- [tester](tester.md)
- [judge](judge.md)
- [docser](docser.md)
- [cycle-manager](cycle-manager.md)

## 8. Common Misconceptions (Agent Responsibility Triage)

- Q. `queued` task not progressing. Is it Worker's problem?
  - A. Check Dispatcher first. Dispatch, lease, agent assignment are Dispatcher's responsibility.
  - Initial APIs: `GET /agents`, `GET /tasks`, `GET /logs/all`
- Q. `awaiting_judge` remains long. Is it Cycle Manager's problem?
  - A. Check Judge first. Approve/rework decisions and backlog consumption are Judge's responsibility.
  - Initial APIs: `GET /judgements`, `GET /system/processes`, `GET /logs/all`
- Q. Same failure repeats. Is Planner bad?
  - A. Check Worker/Tester/Docser and Cycle Manager retry/recovery first for in-progress task failures.
  - Initial APIs: `GET /runs`, `GET /tasks`, `GET /logs/all`
- Q. Planner doesn't start on boot. Is it a failure?
  - A. May be normal due to backlog-first spec. Confirm startup conditions and preflight rules.
  - Initial APIs: `POST /system/preflight`, `GET /system/processes`, `GET /tasks`
- Q. Replan doesn't run. Should I look at Dispatcher?
  - A. Replan decision is Cycle Manager's responsibility. Confirm Planner busy/backlog gate/interval/no-diff conditions.
  - Initial APIs: `GET /tasks`, `GET /plans`, `GET /logs/cycle-manager`
- Q. `issue_linking` doesn't clear. Is it Judge's problem?
  - A. Check Planner/API issue linkage first. Judge is not responsible for resolving `issue_linking`.
  - Initial APIs: `GET /tasks`, `POST /system/preflight`, `GET /logs/all`

Common lookup path:

- State vocabulary: [state-model](../state-model.md)
- Transitions and recovery paths: [flow](../flow.md)
- Owner/implementation lookup: [operations](../operations.md) (8.1)
- Startup condition branches: [startup-patterns](../startup-patterns.md)

## 9. Implementation Reference Map (Source of Truth)

- Planner: `apps/planner/src/`
- Dispatcher: `apps/dispatcher/src/`
- Worker/Tester/Docser: `apps/worker/src/`, `apps/worker/instructions/`
- Judge: `apps/judge/src/`
- Cycle Manager: `apps/cycle-manager/src/`

The "Implementation reference (source of truth)" section in each page lists key files in the above directories.

## 10. Shortest Route for Implementation Tracing (Code Reading Order)

1. Identify owning agent in [README](README.md)
2. Open target agent spec (e.g. [planner](planner.md)) and check "Implementation reference (source of truth)"
3. Read entrypoint (`main.ts`) in the target directory (`apps/*/src`)
4. Then proceed to loop/recovery implementations (`*-runner.ts`, `*-loops.ts`, `scheduler/*`, etc.)

This order makes it easy to round-trip between spec and implementation quickly.

Related:

- [flow](../flow.md)
- [state-model](../state-model.md)
- [policy-recovery](../policy-recovery.md)
- [verification](../verification.md)
- [research](../research.md)
