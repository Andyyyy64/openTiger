# Operating Modes

Operating mode is defined by three axes.

- Repository operation: `REPO_MODE`
- Judge execution: `JUDGE_MODE`
- Worker launch: `LAUNCH_MODE`

## 1. REPO_MODE

### `REPO_MODE=git`

- Work by cloning a remote repo
- Push and create PRs
- Judge is primarily PR-based

Required settings:

- `REPO_URL`
- `BASE_BRANCH`
- `GITHUB_TOKEN`

### `REPO_MODE=local`

- Use `git worktree` in parallel based on `LOCAL_REPO_PATH`
- Do not push or create PRs
- Judge evaluates local diffs

Required settings:

- `LOCAL_REPO_PATH`
- `LOCAL_WORKTREE_ROOT`
- `BASE_BRANCH`

## 2. JUDGE_MODE

- `JUDGE_MODE=git`
  - Force PR mode
- `JUDGE_MODE=local`
  - Force local mode
- `JUDGE_MODE=auto` or unset
  - Follow `REPO_MODE`

Supporting settings:

- `JUDGE_MERGE_ON_APPROVE` (default: true)
- `JUDGE_REQUEUE_ON_NON_APPROVE` (default: true)
- `JUDGE_LOCAL_BASE_REPO_RECOVERY=llm|stash|none`

## 3. LAUNCH_MODE

- `LAUNCH_MODE=process`
  - Dispatch queues to resident workers
  - Recommended default for production
- `LAUNCH_MODE=docker`
  - Run one Docker container per task
  - For environments that require stronger isolation

## 4. Recommended Combinations

- CI/PR-centric operation:
  - `REPO_MODE=git`
  - `JUDGE_MODE=auto`
  - `LAUNCH_MODE=process`
- Fast local verification:
  - `REPO_MODE=local`
  - `JUDGE_MODE=auto`
  - `LAUNCH_MODE=process`
- Strict isolation:
  - `REPO_MODE=git` or `local`
  - `LAUNCH_MODE=docker`

## 5. Critical Retry Settings

- `FAILED_TASK_RETRY_COOLDOWN_MS`
- `FAILED_TASK_MAX_RETRY_COUNT`
- `BLOCKED_TASK_RETRY_COOLDOWN_MS`
- `DISPATCH_RETRY_DELAY_MS`

These directly determine the "never stall, finish in parallel" behavior.
