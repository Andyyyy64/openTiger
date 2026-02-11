import { z } from "zod";

// Agent role
export const AgentRole = z.enum([
  "planner", // task generation/splitting
  "worker", // implementation/PR creation
  "judge", // adoption decision
  "tester", // test creation/execution
  "docser", // documentation
]);
export type AgentRole = z.infer<typeof AgentRole>;

// Agent status
export const AgentStatus = z.enum([
  "idle", // idle
  "busy", // busy
  "offline", // offline
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

// Agent schema
export const AgentSchema = z.object({
  id: z.string(),
  role: AgentRole,
  status: AgentStatus.default("idle"),
  currentTaskId: z.string().uuid().nullable(), // current task
  lastHeartbeat: z.date().nullable(), // last heartbeat
  metadata: z
    .object({
      model: z.string().optional(), // model
      provider: z.string().optional(), // provider
      version: z.string().optional(), // agent version
    })
    .optional(),
  createdAt: z.date(),
});
export type Agent = z.infer<typeof AgentSchema>;

// Register agent input schema
export const RegisterAgentInput = z.object({
  id: z.string(),
  role: AgentRole,
  metadata: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;
