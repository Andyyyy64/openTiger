import { z } from "zod";

// Cycle status
export const CycleStatusSchema = z.enum([
  "running", // running
  "completed", // completed
  "aborted", // aborted / manually stopped
]);
export type CycleStatus = z.infer<typeof CycleStatusSchema>;

// Cycle end trigger type
export const CycleTriggerTypeSchema = z.enum([
  "time", // time-based (e.g. every 4 hours)
  "task_count", // task-count based (e.g. every 100 tasks)
  "failure_rate", // failure-rate based (e.g. when >20%)
  "manual", // manual trigger
]);
export type CycleTriggerType = z.infer<typeof CycleTriggerTypeSchema>;

// Cycle stats
export const CycleStatsSchema = z.object({
  tasksCompleted: z.number().default(0),
  tasksFailed: z.number().default(0),
  tasksCancelled: z.number().default(0),
  runsTotal: z.number().default(0),
  totalTokens: z.number().default(0),
  prsCreated: z.number().default(0),
  prsMerged: z.number().default(0),
  prsRejected: z.number().default(0),
  averageTaskDurationMs: z.number().optional(),
  peakConcurrentWorkers: z.number().default(0),
});
export type CycleStats = z.infer<typeof CycleStatsSchema>;

// State snapshot: stores state at cycle start
export const StateSnapshotSchema = z.object({
  pendingTaskCount: z.number(),
  runningTaskCount: z.number(),
  activeAgentCount: z.number(),
  queuedJobCount: z.number(),
  timestamp: z.coerce.date(),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

// Cycle config
export const CycleConfigSchema = z.object({
  // Time-based cycle control
  maxDurationMs: z.number().optional(), // max run time (ms)
  // Task-count based cycle control
  maxTasksPerCycle: z.number().optional(), // max tasks per cycle
  // Failure-rate based cycle control
  maxFailureRate: z.number().min(0).max(1).optional(), // max failure rate (0-1)
  minTasksForFailureCheck: z.number().default(10), // min tasks for failure rate calc
  // Clean restart config
  cleanupOnEnd: z.boolean().default(true), // cleanup on cycle end
  preserveTaskState: z.boolean().default(true), // preserve failed/blocked task state
  // Monitoring config
  statsIntervalMs: z.number().default(60000), // stats update interval
  healthCheckIntervalMs: z.number().default(30000), // health check interval
});
export type CycleConfig = z.infer<typeof CycleConfigSchema>;

// Cycle domain model
export const CycleSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  status: CycleStatusSchema,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  triggerType: CycleTriggerTypeSchema.optional(),
  stateSnapshot: StateSnapshotSchema.optional(),
  stats: CycleStatsSchema.optional(),
  endReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Cycle = z.infer<typeof CycleSchema>;

// New cycle input
export const NewCycleSchema = CycleSchema.omit({
  id: true,
  endedAt: true,
  endReason: true,
}).partial({
  status: true,
  startedAt: true,
  triggerType: true,
  stateSnapshot: true,
  stats: true,
  metadata: true,
});
export type NewCycle = z.infer<typeof NewCycleSchema>;

// Cycle end event
export const CycleEndEventSchema = z.object({
  cycleId: z.string().uuid(),
  triggerType: CycleTriggerTypeSchema,
  reason: z.string(),
  stats: CycleStatsSchema,
});
export type CycleEndEvent = z.infer<typeof CycleEndEventSchema>;

// Anomaly alert
export const AnomalyAlertSchema = z.object({
  type: z.enum([
    "high_failure_rate", // high failure rate
    "cost_spike", // cost spike
    "stuck_task", // stuck task
    "no_progress", // no progress
    "memory_leak", // suspected memory leak
    "agent_timeout", // agent timeout
  ]),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  timestamp: z.coerce.date(),
});
export type AnomalyAlert = z.infer<typeof AnomalyAlertSchema>;
