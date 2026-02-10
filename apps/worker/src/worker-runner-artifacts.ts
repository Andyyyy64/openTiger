import { db } from "@openTiger/db";
import { artifacts } from "@openTiger/db/schema";
import { buildGitHubPrUrl } from "./worker-runner-utils";

export async function attachExistingPrArtifact(params: {
  runId: string;
  prNumber: number;
  repoUrl: string;
}): Promise<string | undefined> {
  const prUrl = buildGitHubPrUrl(params.repoUrl, params.prNumber);
  await db.insert(artifacts).values({
    runId: params.runId,
    type: "pr",
    ref: String(params.prNumber),
    url: prUrl,
    metadata: {
      source: "existing_pr_context",
      reused: true,
    },
  });
  return prUrl;
}
