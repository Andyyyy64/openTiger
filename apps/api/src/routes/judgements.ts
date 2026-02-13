import { Hono } from "hono";
import { db } from "@openTiger/db";
import { artifacts, events, runs } from "@openTiger/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDiffBetweenRefs, getOctokit, getRepoInfo } from "@openTiger/vcs";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const judgementsRoute = new Hono();

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 200);
}

function parseDiffLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 120000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function parseRepoInfoFromPrUrl(prUrl: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(prUrl);
    if (url.hostname !== "github.com") {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repo = segments[1];
    if (!owner || !repo) {
      return undefined;
    }
    return { owner, repo };
  } catch {
    return undefined;
  }
}

async function getPullRequestDiffFromUrl(prNumber: number, prUrl?: string): Promise<string> {
  const octokit = getOctokit();
  const repoInfo = prUrl ? parseRepoInfoFromPrUrl(prUrl) : undefined;
  const { owner, repo } = repoInfo ?? getRepoInfo();
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: {
      format: "diff",
    },
  });
  return String(response.data ?? "");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    set.add(trimmed);
  }
  return Array.from(set);
}

judgementsRoute.get("/:id/diff", async (c) => {
  const id = c.req.param("id");
  const diffLimit = parseDiffLimit(c.req.query("limit"), 20000);

  const result = await db
    .select({
      id: events.id,
      type: events.type,
      payload: events.payload,
    })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);

  if (result.length === 0 || result[0]?.type !== "judge.review") {
    return c.json({ error: "Judgement not found" }, 404);
  }

  const payload = isRecord(result[0]?.payload) ? result[0].payload : {};
  const runId = readString(payload, "runId");
  const mode = readString(payload, "mode");
  const worktreePath = readString(payload, "worktreePath");
  const baseBranch = readString(payload, "baseBranch");
  const branchName = readString(payload, "branchName");
  const prNumber = readNumber(payload, "prNumber");
  const prUrl = readString(payload, "prUrl");

  let diff = "";
  let source = "unknown";
  let truncated = false;
  let lastError: string | undefined;

  // Search in order: saved artifacts -> local diff -> PR diff
  if (runId) {
    const storedDiff = await db
      .select({
        metadata: artifacts.metadata,
      })
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.type, "base_repo_diff")))
      .limit(1);
    const metadata = storedDiff[0]?.metadata;
    if (isRecord(metadata)) {
      const storedText = readString(metadata, "diff");
      if (storedText) {
        diff = storedText;
        source = "base_repo_diff";
        truncated = Boolean(metadata.diffTruncated);
      }
    }
  }

  if (!diff && mode === "local" && worktreePath && baseBranch && branchName) {
    const diffResult = await getDiffBetweenRefs(worktreePath, baseBranch, branchName);
    if (diffResult.success) {
      diff = diffResult.stdout;
      source = "local";
    } else {
      lastError = diffResult.stderr || "local diff failed";
    }
  }

  if (!diff && typeof prNumber === "number") {
    try {
      diff = await getPullRequestDiffFromUrl(prNumber, prUrl);
      if (diff) {
        source = "pr";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[Judgements] Failed to fetch PR diff:", error);
    }
  }

  // Restore diff from local workspace if available, even on GitHub auth error
  if (!diff && runId) {
    const [runRecord] = await db
      .select({
        taskId: runs.taskId,
        agentId: runs.agentId,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    const [branchArtifact] = await db
      .select({
        ref: artifacts.ref,
      })
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.type, "branch")))
      .limit(1);

    if (runRecord?.taskId && runRecord.agentId && branchArtifact?.ref) {
      const workspaceRoot = process.env.WORKSPACE_PATH ?? "/tmp/openTiger-workspace";
      const repoPath = join(workspaceRoot, runRecord.agentId, runRecord.taskId);
      if (existsSync(repoPath)) {
        const baseCandidates = uniqueStrings([
          baseBranch,
          process.env.BASE_BRANCH,
          "master",
          "main",
        ]);
        for (const candidateBase of baseCandidates) {
          const localDiff = await getDiffBetweenRefs(repoPath, candidateBase, branchArtifact.ref);
          if (localDiff.success && localDiff.stdout.trim().length > 0) {
            diff = localDiff.stdout;
            source = `workspace:${candidateBase}`;
            break;
          }
          if (!localDiff.success && localDiff.stderr) {
            lastError = localDiff.stderr;
          }
        }
      }
    }
  }

  if (!diff) {
    const message = lastError ? `Diff not available: ${lastError}` : "Diff not available";
    return c.json({ error: message }, 404);
  }

  if (diff.length > diffLimit) {
    diff = `${diff.slice(0, diffLimit)}\n... (truncated)`;
    truncated = true;
  }

  return c.json({ diff, truncated, source });
});

judgementsRoute.get("/", async (c) => {
  const taskId = c.req.query("taskId");
  const runId = c.req.query("runId");
  const verdict = c.req.query("verdict");
  const includeRecovery = (c.req.query("includeRecovery") ?? "false").toLowerCase() === "true";
  const limit = parseLimit(c.req.query("limit"), 50);

  const eventTypes = includeRecovery
    ? [
        "judge.review",
        "task.policy_recovery_decided",
        "task.policy_recovery_applied",
        "task.policy_recovery_denied",
      ]
    : ["judge.review"];

  const conditions = [inArray(events.type, eventTypes)];
  if (taskId) {
    conditions.push(eq(events.entityId, taskId));
  }
  if (runId) {
    conditions.push(sql`${events.payload} ->> 'runId' = ${runId}`);
  }
  if (verdict) {
    conditions.push(sql`${events.payload} ->> 'verdict' = ${verdict}`);
  }

  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      createdAt: events.createdAt,
      agentId: events.agentId,
      entityId: events.entityId,
      payload: events.payload,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  // Return payload as-is so UI can build details
  const judgements = rows.map((row) => ({
    payload:
      isRecord(row.payload) &&
      row.type !== "judge.review" &&
      typeof row.payload.summary === "string"
        ? {
            ...row.payload,
            recoverySummary: row.payload.summary,
          }
        : row.payload,
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
    agentId: row.agentId,
    taskId: row.entityId,
  }));

  return c.json({ judgements });
});
