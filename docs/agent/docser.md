# Docser Agent

## 1. Role

Update documentation to follow code changes and prevent drift between implementation and operations.

Docser runs on the Worker foundation as `AGENT_ROLE=docser`.

## 2. Triggers

- Automatically create docser tasks after Judge approval
- Triggers in both local mode and git mode

## 3. Inputs

- Diff information for the target run
- Goal/context from the original task
- Target documents to update

## 4. Outputs

- Docs update diffs
- Verification results
- Run/task/event records

## 5. Key Policies

- Write only factual implementation details
- Do not expand specs based on assumptions
- Strictly obey allowed paths
- Keep changes small and easy to review

## 6. Main Settings

- `AGENT_ROLE=docser`
- `DOCSER_MODEL`
- `DOCSER_INSTRUCTIONS_PATH`
- `OPENTIGER_LOG_DIR`

## 7. Improvement Areas

- Templates by change type
- Improve doc-missing detection accuracy
- Automated aggregation updates for README/docs/task.md
