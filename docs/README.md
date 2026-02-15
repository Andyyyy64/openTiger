# Documentation Index (openTiger)

This directory organizes openTiger implementation specifications into "navigation paths" and "references."  
With source code as the source of truth, information necessary for operations is structured for progressive reading.

## Table of Contents

- [0. Purpose-Based Navigation](#0-purpose-based-navigation)
- [0.1 Recommended Lanes by Reader Type](#01-recommended-lanes-by-reader-type)
- [1. First-Time User Path (Shortest)](#1-first-time-user-path-shortest)
- [2. Execution Model and Recovery Strategy](#2-execution-model-and-recovery-strategy)
- [3. Agent Specifications](#3-agent-specifications)
- [4. Design Principles and Supplementary Materials](#4-design-principles-and-supplementary-materials)
- [Recommended Reading Order (Shortest)](#recommended-reading-order-shortest)
- [Lookup When Making Changes](#lookup-when-making-changes)

## 0. Purpose-Based Navigation

| Purpose                                                            | Shortest Page to Read                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Want to get it running first                                       | [getting-started](getting-started.md)                                               |
| Want to grasp the overview                                         | [architecture](architecture.md)                                                     |
| Want to tune config keys                                           | [config](config.md)                                                                 |
| Want API integration                                               | [api-reference](api-reference.md)                                                   |
| Want to build your own plugin                                      | [plugins](plugins.md)                                                               |
| Need incident response                                             | [operations](operations.md) + [flow](flow.md)                                       |
| Quick initial diagnosis of stalled state                           | [state-model](state-model.md)                                                       |
| Immediate lookup of `retry.reason` meanings                        | [state-model](state-model.md)                                                       |
| Trace by state vocabulary -> transition -> owner -> implementation | [state-model](state-model.md) -> [flow](flow.md) -> [agent/README](agent/README.md) |
| Confirm startup condition formulas                                 | [startup-patterns](startup-patterns.md)                                             |
| Compare agent role differences                                     | [agent/README](agent/README.md)                                                     |
| Build/run TigerResearch (query -> evidence-backed report)          | [research](research.md)                                                             |

## 0.1 Recommended Lanes by Reader Type

### Lane A: First-Time Users (shortest path to run)

1. [getting-started](getting-started.md)
2. [architecture](architecture.md)
3. [operations](operations.md)

Goals:

- Complete the first run
- Finish the 5-minute post-startup check

### Lane B: Operations (stable operation and recovery)

1. [operations](operations.md)
2. [config](config.md)
3. [state-model](state-model.md)
4. [flow](flow.md)
5. [startup-patterns](startup-patterns.md)

Goals:

- Perform rapid triage and restart decisions during incidents
- Avoid mistakes in impact scope of config changes

Shortcut for stalled state:

- [state-model](state-model.md) -> [flow](flow.md) -> [operations](operations.md) (8.1 "State vocabulary -> transition -> owner -> implementation lookup") -> [agent/README](agent/README.md)

### Lane C: Implementation Tracing (track source diffs)

1. [architecture](architecture.md)
2. [agent/README](agent/README.md)
3. [agent/planner](agent/planner.md), [agent/dispatcher](agent/dispatcher.md), [agent/worker](agent/worker.md), etc.
4. [api-reference](api-reference.md)
5. [config](config.md)

Goals:

- Understand component responsibilities and implementation boundaries
- Trace related areas without omission when changing API/config
- Reach code quickly via "Implementation reference (source of truth)" in [agent specs](agent/README.md)

### Lane D: TigerResearch Design/Operation

1. [research](research.md)
2. [architecture](architecture.md)
3. [flow](flow.md)
4. [api-reference](api-reference.md)
5. [operations](operations.md)
6. [plugins](plugins.md)

Goals:

- Understand planner-first research orchestration
- Tune quality thresholds and runtime behavior
- Troubleshoot research stalls/cancellations quickly

## 1. First-Time User Path (Shortest)

1. [getting-started](getting-started.md)
   - Setup, first run, execution start via Start page
2. [architecture](architecture.md)
   - Component responsibilities and data flow
3. [config](config.md)
   - `system_config` and environment variable reference
4. [api-reference](api-reference.md)
   - Main endpoints for Dashboard/API integration
5. [operations](operations.md)
   - Operations, incident recovery, log inspection, runtime hatch

## 2. Execution Model and Recovery Strategy

- [state-model](state-model.md)
  - State definitions for task/run/agent/cycle
- [flow](flow.md)
  - End-to-end state transitions and recovery loops
- [startup-patterns](startup-patterns.md)
  - Startup preflight rules and runtime convergence conditions
- [mode](mode.md)
  - `REPO_MODE` / `JUDGE_MODE` / execution mode operation guidelines
- [execution-mode](execution-mode.md)
  - host/sandbox execution differences and sandbox authentication
- [policy-recovery](policy-recovery.md)
  - Policy violation recovery, allowedPaths self-growth
- [verification](verification.md)
  - Planner/Worker verification command resolution strategy
- [verify-recovery](verify-recovery.md)
  - Verification recovery index (Worker/Cycle Manager split docs)
- [verify-recovery-worker](verify-recovery-worker.md)
  - Worker-side failure code resolution and skip/retry guard behavior
- [verify-recovery-cycle-manager](verify-recovery-cycle-manager.md)
  - Cycle Manager-side command adjustment and blocked/failed requeue behavior
- [research](research.md)
  - TigerResearch planner-first lifecycle and quality gates

## 3. Agent Specifications

- [agent/README](agent/README.md) (cross-agent comparison)
- [agent/planner](agent/planner.md)
- [agent/dispatcher](agent/dispatcher.md)
- [agent/worker](agent/worker.md)
- [agent/tester](agent/tester.md)
- [agent/judge](agent/judge.md)
- [agent/docser](agent/docser.md)
- [agent/cycle-manager](agent/cycle-manager.md)

## 4. Design Principles and Supplementary Materials

- [nonhumanoriented](nonhumanoriented.md)
  - Design principles based on non-stalling assumption
- [requirement](requirement.md)
  - Requirement template example
- [idea](idea.md)
  - Improvement idea notes (future plans)
- [research](research.md)
  - Query-driven research subsystem specification
- [plugins](plugins.md)
  - Plugin registry and extension implementation guide

## Recommended Reading Order (Shortest)

1. [getting-started](getting-started.md)
2. [architecture](architecture.md)
3. [config](config.md)
4. [api-reference](api-reference.md)
5. [operations](operations.md)
6. [flow](flow.md)
7. [agent/README](agent/README.md)

## Lookup When Making Changes

- When changing startup conditions or replan conditions:
  - [startup-patterns](startup-patterns.md)
  - [flow](flow.md) (related runtime impact)
- When changing task state transitions or blocked recovery:
  - [state-model](state-model.md)
  - [flow](flow.md)
  - [operations](operations.md)
- When changing agent implementation responsibilities:
  - [agent/README](agent/README.md)
  - Target [agent specs](agent/README.md)
