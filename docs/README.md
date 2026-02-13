# Documentation Index (openTiger)

This directory organizes openTiger implementation specifications into "navigation paths" and "references."  
With source code as the source of truth, information necessary for operations is structured for progressive reading.

## 0. Purpose-Based Navigation

| Purpose | Shortest Page to Read |
| --- | --- |
| Want to get it running first | `docs/getting-started.md` |
| Want to grasp the overview | `docs/architecture.md` |
| Want to tune config keys | `docs/config.md` |
| Want API integration | `docs/api-reference.md` |
| Need incident response | `docs/operations.md` + `docs/flow.md` |
| Quick initial diagnosis of stalled state | `docs/state-model.md` |
| Immediate lookup of `retry.reason` meanings | `docs/state-model.md` |
| Trace by state vocabulary -> transition -> owner -> implementation | `docs/state-model.md` -> `docs/flow.md` -> `docs/agent/README.md` |
| Confirm startup condition formulas | `docs/startup-patterns.md` |
| Compare agent role differences | `docs/agent/README.md` |

## 0.1 Recommended Lanes by Reader Type

### Lane A: First-Time Users (shortest path to run)

1. `docs/getting-started.md`
2. `docs/architecture.md`
3. `docs/operations.md`

Goals:

- Complete the first run
- Finish the 5-minute post-startup check

### Lane B: Operations (stable operation and recovery)

1. `docs/operations.md`
2. `docs/config.md`
3. `docs/state-model.md`
4. `docs/flow.md`
5. `docs/startup-patterns.md`

Goals:

- Perform rapid triage and restart decisions during incidents
- Avoid mistakes in impact scope of config changes

Shortcut for stalled state:

- `docs/state-model.md` -> `docs/flow.md` -> `docs/operations.md` (8.1 "State vocabulary -> transition -> owner -> implementation lookup") -> `docs/agent/README.md`

### Lane C: Implementation Tracing (track source diffs)

1. `docs/architecture.md`
2. `docs/agent/README.md`
3. `docs/agent/*.md`
4. `docs/api-reference.md`
5. `docs/config.md`

Goals:

- Understand component responsibilities and implementation boundaries
- Trace related areas without omission when changing API/config
- Reach code quickly via "Implementation reference (source of truth)" in `docs/agent/*.md`

## 1. First-Time User Path (Shortest)

1. `docs/getting-started.md`
   - Setup, first run, execution start via Start page
2. `docs/architecture.md`
   - Component responsibilities and data flow
3. `docs/config.md`
   - `system_config` and environment variable reference
4. `docs/api-reference.md`
   - Main endpoints for Dashboard/API integration
5. `docs/operations.md`
   - Operations, incident recovery, log inspection, runtime hatch

## 2. Execution Model and Recovery Strategy

- `docs/state-model.md`
  - State definitions for task/run/agent/cycle
- `docs/flow.md`
  - End-to-end state transitions and recovery loops
- `docs/startup-patterns.md`
  - Startup preflight rules and runtime convergence conditions
- `docs/mode.md`
  - `REPO_MODE` / `JUDGE_MODE` / execution mode operation guidelines
- `docs/execution-mode.md`
  - host/sandbox execution differences and sandbox authentication
- `docs/policy-recovery.md`
  - Policy violation recovery, allowedPaths self-growth
- `docs/verification.md`
  - Planner/Worker verification command resolution strategy

## 3. Agent Specifications

- `docs/agent/README.md` (cross-agent comparison)
- `docs/agent/planner.md`
- `docs/agent/dispatcher.md`
- `docs/agent/worker.md`
- `docs/agent/tester.md`
- `docs/agent/judge.md`
- `docs/agent/docser.md`
- `docs/agent/cycle-manager.md`

## 4. Design Principles and Supplementary Materials

- `docs/nonhumanoriented.md`
  - Design principles based on non-stalling assumption
- `docs/requirement.md`
  - Requirement template example
- `docs/idea.md`
  - Improvement idea notes (future plans)

## Recommended Reading Order (Shortest)

1. `docs/getting-started.md`
2. `docs/architecture.md`
3. `docs/config.md`
4. `docs/api-reference.md`
5. `docs/operations.md`
6. `docs/flow.md`
7. `docs/agent/README.md`

## Lookup When Making Changes

- When changing startup conditions or replan conditions:
  - `docs/startup-patterns.md`
  - `docs/flow.md` (related runtime impact)
- When changing task state transitions or blocked recovery:
  - `docs/state-model.md`
  - `docs/flow.md`
  - `docs/operations.md`
- When changing agent implementation responsibilities:
  - `docs/agent/README.md`
  - Target `docs/agent/*.md`
