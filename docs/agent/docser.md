# Docser Agent Specification

Related:

- `docs/agent/README.md`
- `docs/agent/worker.md`
- `docs/verification.md`
- `docs/policy-recovery.md`

## 1. Role

Docser is a derived role of the Worker runtime running with `AGENT_ROLE=docser`.  
This page documents only Docser-specific differences.

For shared execution flow, state transitions, and safety constraints, see `docs/agent/worker.md`.

## 2. Main Triggers

- Doc-follow task creation after Judge
- Planner-injected doc-gap task when repository docs are insufficient or incomplete

## 3. Expected Output

- Concise documentation diffs under allowed paths
- Verified documentation updates tied to run/task records

## 4. Guardrails

- Prefer implemented facts over speculative design
- Strictly respect strict allowed paths
- Keep changes reviewable in size and scope
- Use doc-safe verification commands (e.g. `pnpm run check`)
- No LLM-based policy recovery; limited to deterministic handling

## 5. Main Configuration

- `AGENT_ROLE=docser`
- `DOCSER_MODEL`
- `DOCSER_INSTRUCTIONS_PATH`
- `OPENTIGER_LOG_DIR`

For shared settings (retry/policy recovery/verify recovery, etc.), see `docs/agent/worker.md`.

## 6. Implementation Reference (Source of Truth)

- Role startup branching: `apps/worker/src/main.ts`
- Role-specific instructions: `apps/worker/instructions/docser.md`
- Doc-safe verification constraints: `apps/worker/src/worker-runner-verification.ts`
- Docser-specific helper behavior: `apps/worker/src/worker-task-helpers.ts`
- Shared execution body: `apps/worker/src/worker-runner.ts`
