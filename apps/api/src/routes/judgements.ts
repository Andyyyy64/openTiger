import { Hono } from "hono";
import { db } from "@sebastian-code/db";
import { artifacts, events } from "@sebastian-code/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDiffBetweenRefs, getOctokit, getRepoInfo } from "@sebastian-code/vcs";

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

async function getPullRequestDiff(prNumber: number): Promise<string> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();
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

  let diff = "";
  let source = "unknown";
  let truncated = false;

  // 保存済みの成果物 -> ローカル差分 -> PR差分の順に探索する
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
    }
  }

  if (!diff && typeof prNumber === "number") {
    diff = await getPullRequestDiff(prNumber);
    source = "pr";
  }

  if (!diff) {
    return c.json({ error: "Diff not available" }, 404);
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
  const limit = parseLimit(c.req.query("limit"), 50);

  const conditions = [eq(events.type, "judge.review")];
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
      createdAt: events.createdAt,
      agentId: events.agentId,
      entityId: events.entityId,
      payload: events.payload,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  // UI側で詳細を組み立てられるようpayloadをそのまま返す
  const judgements = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    agentId: row.agentId,
    taskId: row.entityId,
    payload: row.payload,
  }));

  return c.json({ judgements });
});
