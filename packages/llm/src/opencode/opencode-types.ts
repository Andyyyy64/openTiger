import { z } from "zod";
import type { OpenCodeTokenUsage } from "./parse";

// OpenCode execution options
export const OpenCodeOptions = z.object({
  // Working directory
  workdir: z.string(),
  // Instructions file path
  instructionsPath: z.string().optional(),
  // Task content
  task: z.string(),
  // Timeout (seconds)
  timeoutSeconds: z.number().int().positive().default(3600),
  // Environment variables
  env: z.record(z.string()).optional(),
  // Whether to inherit existing environment variables
  inheritEnv: z.boolean().optional(),
  // Model to use (e.g., google/gemini-2.0-flash-exp)
  model: z.string().optional(),
  // Retry configuration
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
  // Runtime executor backend
  provider: z.enum(["opencode", "claude_code", "codex"]).optional(),
});
export type OpenCodeOptions = z.infer<typeof OpenCodeOptions>;

// Execution result
export interface OpenCodeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  tokenUsage?: OpenCodeTokenUsage;
  retryCount: number;
}
