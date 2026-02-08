# Tester Agent

## 1. Role

A dedicated worker role for test-related tasks.

It uses the same execution foundation as Worker and runs with `AGENT_ROLE=tester`.

## 2. Expected Work

- Prepare verification commands for existing implementations
- Add unit/integration/E2E tests
- Summarize failure logs

## 3. Current Design Policy

- Test tasks are tagged with `role=tester` by Planner
- Dispatcher routes to tester agents based on role
- Use verify commands that finish non-interactively

## 4. Recommended Operation

- Use `vitest run` (no watch mode)
- Run E2E on a dedicated port
- Store results in run/artifacts so Judge can track them

## 5. Main Settings

- `AGENT_ROLE=tester`
- `TESTER_MODEL`
- `TESTER_INSTRUCTIONS_PATH`
- `OPENTIGER_E2E_PORT`

## 6. Not Implemented / Improvement Areas

- Improve flake auto-detection accuracy
- Estimate test scope based on diff
- Standardize E2E artifact retention
