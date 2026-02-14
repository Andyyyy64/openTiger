import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

// Tasks table: work unit management
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  goal: text("goal").notNull(), // Completion condition
  context: jsonb("context"), // Related info (files, specs, notes)
  allowedPaths: text("allowed_paths").array().notNull(), // Allowed change paths
  commands: text("commands").array().notNull(), // Verification commands
  priority: integer("priority").default(0).notNull(),
  riskLevel: text("risk_level").default("low").notNull(), // low/medium/high
  role: text("role").default("worker").notNull(), // worker/tester
  kind: text("kind").default("code").notNull(), // code/research
  status: text("status").default("queued").notNull(), // queued/running/done/failed/blocked/cancelled
  blockReason: text("block_reason"), // Block reason (awaiting_judge/needs_rework)
  targetArea: text("target_area"), // Assigned area (conflict control)
  touches: text("touches").array().default([]).notNull(), // Target files/dirs
  dependencies: uuid("dependencies").array().default([]).notNull(), // Preceding task IDs
  timeboxMinutes: integer("timebox_minutes").default(60).notNull(),
  retryCount: integer("retry_count").default(0).notNull(), // Retry count
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Runs table: agent execution history
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .references(() => tasks.id)
    .notNull(),
  agentId: text("agent_id").notNull(), // Executing agent id
  status: text("status").default("running").notNull(), // running/success/failed/cancelled
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  costTokens: integer("cost_tokens"), // Token usage
  logPath: text("log_path"), // Log file path
  errorMessage: text("error_message"),
  errorMeta: jsonb("error_meta"),
  judgedAt: timestamp("judged_at", { withTimezone: true }),
  judgementVersion: integer("judgement_version").default(0).notNull(),
});

// Artifacts table: PR, commit, CI result, etc.
export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => runs.id)
    .notNull(),
  type: text("type").notNull(), // pr/commit/ci_result/branch
  ref: text("ref"), // PR number, commit SHA, etc.
  url: text("url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Leases table: temporary task ownership (lock alternative)
export const leases = pgTable("leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .references(() => tasks.id)
    .unique()
    .notNull(),
  agentId: text("agent_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Events table: audit log
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // task.created, run.started, pr.merged, etc.
  entityType: text("entity_type").notNull(), // task, run, artifact, etc.
  entityId: uuid("entity_id").notNull(),
  agentId: text("agent_id"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Agents table: registered agents
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  role: text("role").notNull(), // planner/worker/judge
  status: text("status").default("idle").notNull(), // idle/busy/offline
  currentTaskId: uuid("current_task_id").references(() => tasks.id),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Cycles table: run cycle management (for clean restart)
export const cycles = pgTable("cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number").notNull(), // Cycle number (1, 2, 3...)
  status: text("status").default("running").notNull(), // running/completed/aborted
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  // Cycle end condition
  triggerType: text("trigger_type"), // time/task_count/failure_rate/manual
  // State snapshot at cycle start
  stateSnapshot: jsonb("state_snapshot"),
  // Cycle stats
  stats: jsonb("stats"), // { tasksCompleted, tasksFailed, totalTokens, etc. }
  // Cycle end reason
  endReason: text("end_reason"),
  metadata: jsonb("metadata"),
});

// Config table: persist system config in DB
export const config = pgTable("config", {
  id: uuid("id").primaryKey().defaultRandom(),
  maxConcurrentWorkers: text("max_concurrent_workers").default("-1").notNull(),
  dailyTokenLimit: text("daily_token_limit").default("-1").notNull(),
  hourlyTokenLimit: text("hourly_token_limit").default("-1").notNull(),
  taskTokenLimit: text("task_token_limit").default("-1").notNull(),
  dispatcherEnabled: text("dispatcher_enabled").default("true").notNull(),
  judgeEnabled: text("judge_enabled").default("true").notNull(),
  cycleManagerEnabled: text("cycle_manager_enabled").default("true").notNull(),
  executionEnvironment: text("execution_environment").default("host").notNull(),
  workerCount: text("worker_count").default("4").notNull(),
  testerCount: text("tester_count").default("4").notNull(),
  docserCount: text("docser_count").default("4").notNull(),
  judgeCount: text("judge_count").default("4").notNull(),
  plannerCount: text("planner_count").default("1").notNull(),
  repoMode: text("repo_mode").default("git").notNull(),
  repoUrl: text("repo_url").default("").notNull(),
  localRepoPath: text("local_repo_path").default("").notNull(),
  localWorktreeRoot: text("local_worktree_root").default("").notNull(),
  baseBranch: text("base_branch").default("main").notNull(),
  llmExecutor: text("llm_executor").default("claude_code").notNull(),
  workerLlmExecutor: text("worker_llm_executor").default("inherit").notNull(),
  testerLlmExecutor: text("tester_llm_executor").default("inherit").notNull(),
  docserLlmExecutor: text("docser_llm_executor").default("inherit").notNull(),
  judgeLlmExecutor: text("judge_llm_executor").default("inherit").notNull(),
  plannerLlmExecutor: text("planner_llm_executor").default("inherit").notNull(),
  opencodeModel: text("opencode_model").default("google/gemini-3-flash-preview").notNull(),
  opencodeSmallModel: text("opencode_small_model").default("google/gemini-2.5-flash").notNull(),
  opencodeWaitOnQuota: text("opencode_wait_on_quota").default("true").notNull(),
  opencodeQuotaRetryDelayMs: text("opencode_quota_retry_delay_ms").default("30000").notNull(),
  opencodeMaxQuotaWaits: text("opencode_max_quota_waits").default("-1").notNull(),
  codexModel: text("codex_model").default("gpt-5.3-codex").notNull(),
  codexMaxRetries: text("codex_max_retries").default("3").notNull(),
  codexRetryDelayMs: text("codex_retry_delay_ms").default("5000").notNull(),
  claudeCodePermissionMode: text("claude_code_permission_mode")
    .default("bypassPermissions")
    .notNull(),
  claudeCodeModel: text("claude_code_model").default("claude-opus-4-6").notNull(),
  claudeCodeMaxTurns: text("claude_code_max_turns").default("0").notNull(),
  claudeCodeAllowedTools: text("claude_code_allowed_tools").default("").notNull(),
  claudeCodeDisallowedTools: text("claude_code_disallowed_tools").default("").notNull(),
  claudeCodeAppendSystemPrompt: text("claude_code_append_system_prompt").default("").notNull(),
  plannerModel: text("planner_model").default("google/gemini-3-pro-preview").notNull(),
  judgeModel: text("judge_model").default("google/gemini-3-pro-preview").notNull(),
  workerModel: text("worker_model").default("google/gemini-3-flash-preview").notNull(),
  testerModel: text("tester_model").default("google/gemini-3-flash-preview").notNull(),
  docserModel: text("docser_model").default("google/gemini-3-flash-preview").notNull(),
  plannerUseRemote: text("planner_use_remote").default("true").notNull(),
  plannerRepoUrl: text("planner_repo_url").default("").notNull(),
  autoReplan: text("auto_replan").default("true").notNull(),
  replanRequirementPath: text("replan_requirement_path").default("requirement.md").notNull(),
  replanIntervalMs: text("replan_interval_ms").default("60000").notNull(),
  replanCommand: text("replan_command")
    .default("pnpm --filter @openTiger/planner run start:fresh")
    .notNull(),
  replanWorkdir: text("replan_workdir").default("").notNull(),
  replanRepoUrl: text("replan_repo_url").default("").notNull(),
  githubAuthMode: text("github_auth_mode").default("gh").notNull(),
  githubToken: text("github_token").default("").notNull(),
  githubOwner: text("github_owner").default("").notNull(),
  githubRepo: text("github_repo").default("").notNull(),
  // API Keys for LLM providers
  anthropicApiKey: text("anthropic_api_key").default("").notNull(),
  geminiApiKey: text("gemini_api_key").default("").notNull(),
  openaiApiKey: text("openai_api_key").default("").notNull(),
  xaiApiKey: text("xai_api_key").default("").notNull(),
  deepseekApiKey: text("deepseek_api_key").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Type exports
export type TaskRecord = typeof tasks.$inferSelect;
export type NewTaskRecord = typeof tasks.$inferInsert;

export type RunRecord = typeof runs.$inferSelect;
export type NewRunRecord = typeof runs.$inferInsert;

export type ArtifactRecord = typeof artifacts.$inferSelect;
export type NewArtifactRecord = typeof artifacts.$inferInsert;

export type LeaseRecord = typeof leases.$inferSelect;
export type NewLeaseRecord = typeof leases.$inferInsert;

export type EventRecord = typeof events.$inferSelect;
export type NewEventRecord = typeof events.$inferInsert;

export type AgentRecord = typeof agents.$inferSelect;
export type NewAgentRecord = typeof agents.$inferInsert;

export type CycleRecord = typeof cycles.$inferSelect;
export type NewCycleRecord = typeof cycles.$inferInsert;

export type ConfigRecord = typeof config.$inferSelect;
export type NewConfigRecord = typeof config.$inferInsert;

export {
  tigerResearchJobs as researchJobs,
  tigerResearchClaims as researchClaims,
  tigerResearchEvidence as researchEvidence,
  tigerResearchReports as researchReports,
  tigerResearchJobs,
  tigerResearchClaims,
  tigerResearchEvidence,
  tigerResearchReports,
  type TigerResearchJobRecord as ResearchJobRecord,
  type NewTigerResearchJobRecord as NewResearchJobRecord,
  type TigerResearchClaimRecord as ResearchClaimRecord,
  type NewTigerResearchClaimRecord as NewResearchClaimRecord,
  type TigerResearchEvidenceRecord as ResearchEvidenceRecord,
  type NewTigerResearchEvidenceRecord as NewResearchEvidenceRecord,
  type TigerResearchReportRecord as ResearchReportRecord,
  type NewTigerResearchReportRecord as NewResearchReportRecord,
  type TigerResearchJobRecord,
  type NewTigerResearchJobRecord,
  type TigerResearchClaimRecord,
  type NewTigerResearchClaimRecord,
  type TigerResearchEvidenceRecord,
  type NewTigerResearchEvidenceRecord,
  type TigerResearchReportRecord,
  type NewTigerResearchReportRecord,
} from "./plugins/tiger-research";
