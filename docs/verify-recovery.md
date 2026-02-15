# Verification Recovery (Index)

This page is an entry point for verification-command failure handling.

Related:

- [verification](verification.md)
- [policy-recovery](policy-recovery.md)
- [flow](flow.md)
- [state-model](state-model.md)
- [operations](operations.md)

## 1. Split Docs

- Worker-side behavior:
  - [verify-recovery-worker](verify-recovery-worker.md)
- Cycle Manager-side behavior:
  - [verify-recovery-cycle-manager](verify-recovery-cycle-manager.md)

## 2. Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation)

When tracing verification failures:

1. [state-model](state-model.md) (`needs_rework` / `quota_wait`, etc.)
2. [flow](flow.md) (Worker failure handling and blocked recovery transitions)
3. [operations](operations.md) (API procedures and operation shortcuts)
4. [agent/README](agent/README.md) (owning agent and implementation tracing path)

## 3. Boundary with Policy Recovery

Verification recovery (command adjustment/requeue, setup/bootstrap retry routing)
is separate from policy/path recovery (`allowedPaths`/`deniedPaths`).

Worker-side verification now includes in-place inline command recovery for final setup/format
failures by deriving executable alternatives from `package.json` scripts before escalating to rework.

Policy/path recovery details:

- [policy-recovery](policy-recovery.md)
