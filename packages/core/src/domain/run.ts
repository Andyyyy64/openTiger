import { z } from "zod";

// Run status
export const RunStatus = z.enum([
  "running", // running
  "success", // success
  "failed", // failed
  "cancelled", // cancelled
]);
export type RunStatus = z.infer<typeof RunStatus>;

// Run schema
export const RunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string(), // agent identifier
  status: RunStatus.default("running"),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  costTokens: z.number().int().nonnegative().nullable(), // tokens consumed
  logPath: z.string().nullable(), // log file path
  errorMessage: z.string().nullable(), // error message
  judgedAt: z.date().nullable().optional(),
  judgementVersion: z.number().int().nonnegative().default(0),
});
export type Run = z.infer<typeof RunSchema>;

// Start run input schema
export const StartRunInput = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
});
export type StartRunInput = z.infer<typeof StartRunInput>;

// Complete run input schema
export const CompleteRunInput = z.object({
  status: z.enum(["success", "failed", "cancelled"]),
  costTokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
});
export type CompleteRunInput = z.infer<typeof CompleteRunInput>;
