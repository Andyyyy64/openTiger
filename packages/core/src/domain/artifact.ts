import { z } from "zod";

// Artifact type
export const ArtifactType = z.enum([
  "pr", // Pull Request
  "commit", // commit
  "ci_result", // CI result
  "branch", // branch
  "base_repo_diff", // local base repo diff
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

// Artifact schema
export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  type: ArtifactType,
  ref: z.string().nullable(), // PR number, commit SHA, branch name, etc.
  url: z.string().url().nullable(),
  metadata: z.record(z.unknown()).nullable(), // extra info
  createdAt: z.date(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// Create artifact input schema
export const CreateArtifactInput = ArtifactSchema.omit({
  id: true,
  createdAt: true,
});
export type CreateArtifactInput = z.infer<typeof CreateArtifactInput>;
