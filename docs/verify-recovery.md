# Verification Recovery (Index)

This page is an entry point for verification-command failure handling.

Related:

- `docs/verification.md`
- `docs/policy-recovery.md`
- `docs/flow.md`
- `docs/state-model.md`
- `docs/operations.md`

## 1. Split Docs

- Worker-side behavior:
  - `docs/verify-recovery-worker.md`
- Cycle Manager-side behavior:
  - `docs/verify-recovery-cycle-manager.md`

## 2. Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation)

When tracing verification failures:

1. `docs/state-model.md` (`needs_rework` / `quota_wait`, etc.)
2. `docs/flow.md` (Worker failure handling and blocked recovery transitions)
3. `docs/operations.md` (API procedures and operation shortcuts)
4. `docs/agent/README.md` (owning agent and implementation tracing path)

## 3. Boundary with Policy Recovery

Verification recovery (command adjustment/requeue, setup/bootstrap retry routing)
is separate from policy/path recovery (`allowedPaths`/`deniedPaths`).

Policy/path recovery details:

- `docs/policy-recovery.md`
