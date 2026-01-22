import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@h1ve/db";
import { runs, artifacts } from "@h1ve/db/schema";
import { eq, sql, gte } from "drizzle-orm";

export const runsRoute = new Hono();

// 統計情報取得
runsRoute.get("/stats", async (c) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 本日の消費トークン合計
  const result = await db
    .select({
      totalTokens: sql<number>`sum(COALESCE(${runs.costTokens}, 0))`,
    })
    .from(runs)
    .where(gte(runs.startedAt, today));

  return c.json({
    dailyTokens: Number(result[0]?.totalTokens ?? 0),
    tokenLimit: parseInt(process.env.DAILY_TOKEN_LIMIT ?? "5000000", 10),
  });
});

// 実行履歴一覧取得
runsRoute.get("/", async (c) => {
  const taskId = c.req.query("taskId");
  const status = c.req.query("status");

  let query = db.select().from(runs);

  if (taskId) {
    query = query.where(eq(runs.taskId, taskId)) as typeof query;
  }
  if (status) {
    query = query.where(eq(runs.status, status)) as typeof query;
  }

  const result = await query;
  return c.json({ runs: result });
});

// 実行詳細取得
runsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const runResult = await db.select().from(runs).where(eq(runs.id, id));

  if (runResult.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  // 関連する成果物も取得
  const artifactResult = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, id));

  return c.json({
    run: runResult[0],
    artifacts: artifactResult,
  });
});

// 実行開始リクエストのスキーマ
const startRunSchema = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
});

// 実行開始
runsRoute.post("/", zValidator("json", startRunSchema), async (c) => {
  const body = c.req.valid("json");

  const result = await db
    .insert(runs)
    .values({
      taskId: body.taskId,
      agentId: body.agentId,
      status: "running",
    })
    .returning();

  return c.json({ run: result[0] }, 201);
});

// 実行完了リクエストのスキーマ
const completeRunSchema = z.object({
  status: z.enum(["success", "failed", "cancelled"]),
  costTokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
});

// 実行完了
runsRoute.patch("/:id", zValidator("json", completeRunSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const result = await db
    .update(runs)
    .set({
      status: body.status,
      costTokens: body.costTokens,
      errorMessage: body.errorMessage,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ run: result[0] });
});

// 実行キャンセル
runsRoute.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");

  const result = await db
    .update(runs)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
    })
    .where(eq(runs.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ run: result[0] });
});

// 成果物作成リクエストのスキーマ
const createArtifactSchema = z.object({
  type: z.enum(["pr", "commit", "ci_result", "branch"]),
  ref: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// 成果物追加
runsRoute.post(
  "/:id/artifacts",
  zValidator("json", createArtifactSchema),
  async (c) => {
    const runId = c.req.param("id");
    const body = c.req.valid("json");

    // 実行が存在するか確認
    const runResult = await db.select().from(runs).where(eq(runs.id, runId));
    if (runResult.length === 0) {
      return c.json({ error: "Run not found" }, 404);
    }

    const result = await db
      .insert(artifacts)
      .values({
        runId,
        type: body.type,
        ref: body.ref,
        url: body.url,
        metadata: body.metadata,
      })
      .returning();

    return c.json({ artifact: result[0] }, 201);
  }
);
