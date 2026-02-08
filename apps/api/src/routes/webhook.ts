import { Hono } from "hono";
import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";

export const webhookRoute = new Hono();

// Webhook署名の検証
function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  // sha256=... の形式から署名部分を抽出
  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }

  const signatureHex = parts[1];
  if (!signatureHex) {
    return false;
  }

  // HMAC-SHA256で署名を計算
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const expectedSignature = hmac.digest("hex");

  // タイミング攻撃を防ぐため、一定時間比較を使用
  try {
    return timingSafeEqual(
      Buffer.from(signatureHex, "hex"),
      Buffer.from(expectedSignature, "hex")
    );
  } catch {
    return false;
  }
}

// イベントをDBに記録
async function recordWebhookEvent(
  eventType: string,
  action: string | undefined,
  payload: Record<string, unknown>
): Promise<string> {
  const [event] = await db
    .insert(events)
    .values({
      type: `webhook.${eventType}${action ? `.${action}` : ""}`,
      entityType: "webhook",
      entityId: String(payload.delivery ?? "unknown"),
      payload: {
        action,
        sender: payload.sender,
        repository: payload.repository,
      },
    })
    .returning();

  return event?.id ?? "unknown";
}

// IssueイベントからタスクIDを抽出（Issue本文に [task:uuid] 形式で埋め込まれている場合）
function extractTaskIdFromIssue(body: string | undefined): string | null {
  if (!body) return null;
  const match = body.match(/\[task:([0-9a-f-]{36})\]/i);
  return match?.[1] ?? null;
}

// GitHub Webhook受信エンドポイント
webhookRoute.post("/github", async (c) => {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // 署名検証（シークレットが設定されている場合のみ）
  if (webhookSecret) {
    const signature = c.req.header("X-Hub-Signature-256");
    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      console.warn("[Webhook] Invalid signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    // ボディを再パースするためにリクエストを再構築
    // Honoではボディを一度読むと再度読めないため、手動でパース
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      return await handleWebhookPayload(c, payload);
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }
  }

  // シークレット未設定の場合は直接パース
  const payload = (await c.req.json()) as Record<string, unknown>;
  return await handleWebhookPayload(c, payload);
});

// Webhookペイロードを処理
async function handleWebhookPayload(
  c: { json: (data: unknown, status?: number) => Response },
  payload: Record<string, unknown>
): Promise<Response> {
  const eventType = payload["X-GitHub-Event"] as string | undefined;
  const action = payload.action as string | undefined;

  console.log(`[Webhook] Received: ${eventType ?? "unknown"} ${action ?? ""}`);

  // イベントを記録
  const eventId = await recordWebhookEvent(
    eventType ?? "unknown",
    action,
    payload
  );

  // イベントタイプに応じた処理
  switch (eventType) {
    case "ping":
      return c.json({ message: "pong", eventId });

    case "issues":
      return await handleIssueEvent(c, action, payload, eventId);

    case "pull_request":
      return await handlePullRequestEvent(c, action, payload, eventId);

    case "push":
      return await handlePushEvent(c, payload, eventId);

    case "check_run":
    case "check_suite":
      return await handleCheckEvent(c, action, payload, eventId);

    default:
      console.log(`[Webhook] Unhandled event type: ${eventType}`);
      return c.json({ message: "Event received", eventId });
  }
}

// Issueイベントの処理
async function handleIssueEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string
): Promise<Response> {
  const issue = payload.issue as Record<string, unknown> | undefined;

  if (!issue) {
    return c.json({ error: "Invalid issue payload" }, 400);
  }

  const issueNumber = issue.number as number;
  const issueTitle = issue.title as string;
  const issueBody = issue.body as string | undefined;
  const labels = (issue.labels as Array<{ name: string }>) ?? [];

  console.log(`[Webhook] Issue #${issueNumber}: ${action} - "${issueTitle}"`);

  // 「openTiger」または「auto-task」ラベルが付いている場合、タスクを自動作成
  const shouldAutoTask = labels.some(
    (l) => l.name === "openTiger" || l.name === "auto-task"
  );

  if (action === "opened" && shouldAutoTask) {
    // Plannerにタスク生成を依頼（キューに追加）
    // 実際の実装ではBullMQにジョブを追加
    console.log(`[Webhook] Auto-task triggered for issue #${issueNumber}`);

    return c.json({
      message: "Issue received, task generation triggered",
      eventId,
      issueNumber,
    });
  }

  return c.json({ message: "Issue event processed", eventId, issueNumber });
}

// Pull Requestイベントの処理
async function handlePullRequestEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string
): Promise<Response> {
  const pr = payload.pull_request as Record<string, unknown> | undefined;

  if (!pr) {
    return c.json({ error: "Invalid pull_request payload" }, 400);
  }

  const prNumber = pr.number as number;
  const prTitle = pr.title as string;
  const prBody = pr.body as string | undefined;
  const prState = pr.state as string;

  console.log(`[Webhook] PR #${prNumber}: ${action} - "${prTitle}"`);

  // PRがopenTiger Workerによって作成されたものかチェック
  const isOpenTigerPR =
    (pr.head as Record<string, unknown>)?.ref?.toString().startsWith("agent/") ?? false;

  if (action === "opened" && isOpenTigerPR) {
    // Judgeにレビューを依頼
    console.log(`[Webhook] Judge review triggered for PR #${prNumber}`);
  }

  if (action === "closed" && pr.merged) {
    // PRがマージされた場合、関連タスクを完了に更新
    const taskId = extractTaskIdFromIssue(prBody);
    if (taskId) {
      await db
        .update(tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      console.log(`[Webhook] Task ${taskId} marked as done (PR merged)`);
    }
  }

  return c.json({
    message: "Pull request event processed",
    eventId,
    prNumber,
    isOpenTigerPR,
  });
}

// Pushイベントの処理
async function handlePushEvent(
  c: { json: (data: unknown, status?: number) => Response },
  payload: Record<string, unknown>,
  eventId: string
): Promise<Response> {
  const ref = payload.ref as string;
  const commits = payload.commits as Array<Record<string, unknown>> | undefined;

  console.log(
    `[Webhook] Push to ${ref}: ${commits?.length ?? 0} commits`
  );

  return c.json({
    message: "Push event processed",
    eventId,
    ref,
    commitCount: commits?.length ?? 0,
  });
}

// Check Run/Suiteイベントの処理
async function handleCheckEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string
): Promise<Response> {
  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  const checkSuite = payload.check_suite as Record<string, unknown> | undefined;

  const conclusion =
    (checkRun?.conclusion as string) ?? (checkSuite?.conclusion as string);
  const status =
    (checkRun?.status as string) ?? (checkSuite?.status as string);

  console.log(`[Webhook] Check: ${action} - status=${status}, conclusion=${conclusion}`);

  // CI完了時にJudgeに通知
  if (status === "completed" && conclusion) {
    // 関連するPRを特定してJudgeを起動
    const pullRequests =
      (checkSuite?.pull_requests as Array<Record<string, unknown>>) ??
      (checkRun?.pull_requests as Array<Record<string, unknown>>) ??
      [];

    for (const pr of pullRequests) {
      const prNumber = pr.number as number;
      console.log(
        `[Webhook] CI ${conclusion} for PR #${prNumber}, Judge review may be triggered`
      );
    }
  }

  return c.json({
    message: "Check event processed",
    eventId,
    status,
    conclusion,
  });
}
