# openTiger

![openTiger](assets/avator.png)

**Autonomous development that never stalls. Failures still converge to completion.**


An orchestration system that coordinates multiple AI agents to autonomously run from requirements to implementation, judgement, and retries.  
Completion rate in long-running operation is the first priority, with recovery and convergence built around inevitable failures.  
Design principles are based on [Cursor Research: Scaling Long-Running Autonomous Coding](https://cursor.com/ja/blog/scaling-agents).

![openTiger UI](assets/ui.png)


---

Docs · [Index](docs/README.md) · [Flow](docs/flow.md) · [Modes](docs/mode.md) · [Agents](docs/agent)

---

## Highlights

- Completion-first orchestration with recovery and convergence
- Lease-centric parallel control for long-running workloads
- Idempotent judgement with machine-judgable completion criteria
- Non-destructive verification that avoids mutating project state
- Role-separated agents with operational visibility in the Dashboard

## Never-stall operation rules

- Run long-lived system processes in `start` mode, not `dev/watch`
  - file-watch restarts can interrupt in-flight runs and create duplicate retries
- Planner and Cycle Manager are started via `start:fresh` (clean + build + start) to avoid stale `dist` artifacts
- Worker shutdown must always recover interrupted runs and clear `busy` state
- OpenCode child processes must be terminated when parent processes receive shutdown signals
- Judge non-approve retries use a circuit breaker to avoid infinite requeue loops
  - escalate to `AutoFix` or `needs_rework` instead of retrying forever
- System process auto-restart uses backoff and defaults to unlimited retries (`SYSTEM_PROCESS_AUTO_RESTART_MAX_ATTEMPTS=-1`)

---

## How it works (short)

Requirements → Planner → Dispatcher → Workers/Testers/Docser → Judge → Cycle Manager (requeue/recover)

---

## Core Components

- Planner
  - Generate tasks from requirements
- Dispatcher
  - Task assignment and parallel control
- Worker / Tester / Docser
  - Implementation, testing, and documentation updates
- Judge
  - Judgement and transition control
- Cycle Manager
  - Stuck recovery, requeueing, and metrics management

---

## Environment

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker / Docker Compose
- PostgreSQL
- Redis
- OpenCode CLI

### Setup

```bash
git clone git@github.com:Andyyyy64/openTiger.git
cd openTiger
pnpm install
cp .env.example .env
pnpm restart
```

---

## Quick Start

1. Prepare a requirement
2. Generate tasks with the Planner
3. Start Dispatcher/Worker/Judge/Cycle Manager
4. Monitor `QUEUE AGE MAX` / `BLOCKED > 30M` / `RETRY EXHAUSTED` in the Dashboard

---

## Documentation

- `docs/README.md` (Index)
- `docs/flow.md` (State transitions)
- `docs/mode.md` (Operating modes)
- `docs/nonhumanoriented.md` (Long-running operation principles)
- `docs/task.md` (Implementation status)
- `docs/agent/*.md` (Agent specifications)

---
