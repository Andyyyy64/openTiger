import { z } from "zod";

// Task risk level
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

// Task role
export const TaskRole = z.enum(["worker", "tester", "docser"]);
export type TaskRole = z.infer<typeof TaskRole>;

// Task lane
export const TaskLane = z.enum(["feature", "conflict_recovery", "docser", "research"]);
export type TaskLane = z.infer<typeof TaskLane>;

// Task kind
export const TaskKind = z.enum(["code", "research"]);
export type TaskKind = z.infer<typeof TaskKind>;

// Task status
export const TaskStatus = z.enum([
  "queued", // waiting
  "running", // running
  "done", // done
  "failed", // failed
  "blocked", // blocked (dependency or human intervention)
  "cancelled", // cancelled
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// Task context
export const TaskContext = z.object({
  files: z.array(z.string()).optional(), // related files
  specs: z.string().optional(), // specs/requirements
  notes: z.string().optional(), // notes
  pr: z
    .object({
      number: z.number().int(),
      url: z.string().url().optional(),
      sourceTaskId: z.string().uuid().optional(),
      sourceRunId: z.string().uuid().optional(),
      headRef: z.string().optional(),
      headSha: z.string().optional(),
      baseRef: z.string().optional(),
    })
    .optional(), // PR-based work context
  issue: z
    .object({
      number: z.number().int(),
      url: z.string().url().optional(),
      title: z.string().optional(),
    })
    .optional(), // issue linkage
  research: z
    .object({
      jobId: z.string().uuid().optional(),
      query: z.string().optional(),
      stage: z.string().optional(),
      profile: z.string().optional(),
      claimId: z.string().uuid().optional(),
      claimText: z.string().optional(),
      claims: z.array(z.string()).optional(),
    })
    .optional(),
});
export type TaskContext = z.infer<typeof TaskContext>;

// Task schema
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  goal: z.string().min(1), // completion condition (machine-verifiable)
  context: TaskContext.optional(),
  allowedPaths: z.array(z.string()), // paths allowed for modification
  commands: z.array(z.string()), // verification commands
  priority: z.number().int().default(0),
  riskLevel: RiskLevel.default("low"),
  role: TaskRole.default("worker"),
  lane: TaskLane.default("feature"),
  kind: TaskKind.default("code"),
  status: TaskStatus.default("queued"),
  blockReason: z.string().optional(), // blocked reason (awaiting_judge/needs_rework)
  targetArea: z.string().optional(), // target area (for conflict control)
  touches: z.array(z.string()).default([]), // files/dirs to modify
  dependencies: z.array(z.string().uuid()).default([]), // prerequisite task IDs
  timeboxMinutes: z.number().int().positive().default(60),
  retryCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Task = z.infer<typeof TaskSchema>;

// Create task input schema
export const CreateTaskInput = TaskSchema.omit({
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  priority: true,
  riskLevel: true,
  dependencies: true,
  timeboxMinutes: true,
  context: true,
  retryCount: true,
  lane: true,
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

// Update task input schema
export const UpdateTaskInput = TaskSchema.partial().omit({
  id: true,
  createdAt: true,
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;
