# Idea Notes (Next Phase)

The current implementation has reached "parallel execution that rarely stalls."
The next phase focuses on quality and operational experience.

## 1. Short-term (Priority)

### 1.1 Dedicated queue for needs_human

- Currently only an isolation event exists
- Add dedicated status/queue/UI to make operations explicit

### 1.2 Introduce a triager role

- Connect failure classification directly to task splitting and replanning
- A dedicated role that assists Cycle Manager recovery

### 1.3 Expand health API

- Real checks for DB/Redis/Queue via `/health/ready`
- Return SLO violation counts

## 2. Mid-term

### 2.1 Strengthen tester

- Select tests based on diffs
  - unit / integration / e2e
- Flake detection and automatic isolation

### 2.2 Strengthen docser

- Improve doc-missing detection accuracy
- Template updates by change type

### 2.3 Recursive planning for planner

- Spawn sub-planners for large requirements
- Predict conflict areas early and avoid them during task generation

## 3. Long-term

### 3.1 Deployer + observer

- Promote to staging/prod and auto rollback
- Generate fix tasks based on operational metrics

### 3.2 Requirement interview

- Ask questions automatically to resolve ambiguities
- Version and diff management for requirements

## 4. Target Metrics

- Execution success rate
- Average task completion time
- Retry exhaustion rate
- Count of blocked over 30 minutes
- Count of queued over 5 minutes
