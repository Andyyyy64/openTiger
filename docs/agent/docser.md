# Docser Agent

関連:

- `docs/agent/README.md`
- `docs/agent/worker.md`
- `docs/verification.md`
- `docs/policy-recovery.md`

## 1. Role

Docser は `AGENT_ROLE=docser` で動作する Worker runtime の派生ロールです。  
このページは Docser 固有の差分のみを記載します。

共通の実行フロー・状態遷移・安全制約は `docs/agent/worker.md` を参照してください。

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

共通設定（retry/policy recovery/verify recovery など）は `docs/agent/worker.md` を参照してください。
