# Docser Agent

## 1. Role

Keep documentation aligned with implemented behavior.

Docser uses worker runtime with `AGENT_ROLE=docser`.

## 2. Main Triggers

- post-judge document follow-up task creation
- planner doc-gap injection when repository docs are missing/incomplete

## 3. Expected Outputs

- concise documentation diffs under allowed paths
- verified doc updates attached to run/task records

## 4. Guardrails

- prioritize factual implementation state over speculative design
- respect strict allowed paths
- keep changes reviewable and bounded
- use doc-safe verification commands (for example `pnpm run check`)
- skip LLM-based policy recovery and rely on deterministic policy handling

## 5. Important Settings

- `AGENT_ROLE=docser`
- `DOCSER_MODEL`
- `DOCSER_INSTRUCTIONS_PATH`
- `OPENTIGER_LOG_DIR`
