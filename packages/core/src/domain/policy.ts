import { z } from "zod";

// Policy: defines agent action constraints
export const PolicySchema = z.object({
  // Paths allowed for modification (glob)
  allowedPaths: z.array(z.string()).default(["**/*"]),

  // Paths denied for modification (glob)
  deniedPaths: z.array(z.string()).default([]),

  // Max lines changed
  maxLinesChanged: z.number().int().positive().default(500),

  // Max files changed
  maxFilesChanged: z.number().int().positive().default(20),

  // Denied commands (regex)
  deniedCommands: z.array(z.string()).default(["rm -rf /", "sudo", "chmod 777"]),

  // Auto-merge conditions
  autoMerge: z
    .object({
      enabled: z.boolean().default(false),
      // Risk levels allowed for auto-merge
      maxRiskLevel: z.enum(["low", "medium", "high"]).default("low"),
      // Required CI check names
      requiredChecks: z.array(z.string()).default([]),
    })
    .default({}),

  // Base repo recovery strictness
  baseRepoRecovery: z
    .object({
      level: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .default({}),

  // Token limits
  tokenLimits: z
    .object({
      perTask: z.number().int().positive().default(1000000),
      perDay: z.number().int().positive().default(50000000),
    })
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

// Default policy
export const DEFAULT_POLICY: Policy = PolicySchema.parse({});
