import { Hono } from "hono";
import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export const webhookRoute = new Hono();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeWebhookEntityId(deliveryId: string | undefined): string {
  if (deliveryId && UUID_PATTERN.test(deliveryId)) {
    return deliveryId;
  }
  return randomUUID();
}

// Verify webhook signature
function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) {
    return false;
  }

  // Extract signature part from sha256=... format
  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }

  const signatureHex = parts[1];
  if (!signatureHex) {
    return false;
  }

  // Calculate signature with HMAC-SHA256
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const expectedSignature = hmac.digest("hex");

  // Use constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expectedSignature, "hex"));
  } catch {
    return false;
  }
}

// Record event to DB
async function recordWebhookEvent(
  eventType: string,
  action: string | undefined,
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): Promise<string> {
  const [event] = await db
    .insert(events)
    .values({
      type: `webhook.${eventType}${action ? `.${action}` : ""}`,
      entityType: "webhook",
      entityId: normalizeWebhookEntityId(deliveryId),
      payload: {
        action,
        sender: payload.sender,
        repository: payload.repository,
        deliveryId,
      },
    })
    .returning();

  return event?.id ?? "unknown";
}

// Extract task ID from Issue event (when Issue body contains [task:uuid] format)
function extractTaskIdFromIssue(body: string | undefined): string | null {
  if (!body) return null;
  const match = body.match(/\[task:([0-9a-f-]{36})\]/i);
  return match?.[1] ?? null;
}

// GitHub Webhook receiving endpoint
webhookRoute.post("/github", async (c) => {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const eventType = c.req.header("X-GitHub-Event")?.trim() || undefined;
  const deliveryId = c.req.header("X-GitHub-Delivery")?.trim() || undefined;

  // Verify signature (only if secret is configured)
  if (webhookSecret) {
    const signature = c.req.header("X-Hub-Signature-256");
    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      console.warn("[Webhook] Invalid signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Rebuild request to re-parse body
    // In Hono, body can only be read once, so parse manually
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      return await handleWebhookPayload(c, payload, { eventType, deliveryId });
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }
  }

  // Parse directly if secret is not configured
  const payload = (await c.req.json()) as Record<string, unknown>;
  return await handleWebhookPayload(c, payload, { eventType, deliveryId });
});

// Process webhook payload
async function handleWebhookPayload(
  c: { json: (data: unknown, status?: number) => Response },
  payload: Record<string, unknown>,
  metadata: { eventType?: string; deliveryId?: string },
): Promise<Response> {
  const eventType = metadata.eventType;
  const action = payload.action as string | undefined;

  console.log(`[Webhook] Received: ${eventType ?? "unknown"} ${action ?? ""}`);

  // Record event
  const eventId = await recordWebhookEvent(
    eventType ?? "unknown",
    action,
    payload,
    metadata.deliveryId,
  );

  // Process according to event type
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

// Handle Issue event
async function handleIssueEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<Response> {
  const issue = payload.issue as Record<string, unknown> | undefined;

  if (!issue) {
    return c.json({ error: "Invalid issue payload" }, 400);
  }

  const issueNumber = issue.number as number;
  const issueTitle = issue.title as string;
  const labels = (issue.labels as Array<{ name: string }>) ?? [];

  console.log(`[Webhook] Issue #${issueNumber}: ${action} - "${issueTitle}"`);

  // Auto-create task if "openTiger" or "auto-task" label is present
  const shouldAutoTask = labels.some((l) => l.name === "openTiger" || l.name === "auto-task");

  if (action === "opened" && shouldAutoTask) {
    // Request task generation from Planner (add to queue)
    // In actual implementation, add job to BullMQ
    console.log(`[Webhook] Auto-task triggered for issue #${issueNumber}`);

    return c.json({
      message: "Issue received, task generation triggered",
      eventId,
      issueNumber,
    });
  }

  return c.json({ message: "Issue event processed", eventId, issueNumber });
}

// Handle Pull Request event
async function handlePullRequestEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<Response> {
  const pr = payload.pull_request as Record<string, unknown> | undefined;

  if (!pr) {
    return c.json({ error: "Invalid pull_request payload" }, 400);
  }

  const prNumber = pr.number as number;
  const prTitle = pr.title as string;
  const prBody = pr.body as string | undefined;

  console.log(`[Webhook] PR #${prNumber}: ${action} - "${prTitle}"`);

  // Check if PR was created by openTiger Worker
  const isOpenTigerPR =
    (pr.head as Record<string, unknown>)?.ref?.toString().startsWith("agent/") ?? false;

  if (action === "opened" && isOpenTigerPR) {
    // Request review from Judge
    console.log(`[Webhook] Judge review triggered for PR #${prNumber}`);
  }

  if (action === "closed" && pr.merged) {
    // Update related task to completed if PR was merged
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

// Handle Push event
async function handlePushEvent(
  c: { json: (data: unknown, status?: number) => Response },
  payload: Record<string, unknown>,
  eventId: string,
): Promise<Response> {
  const ref = payload.ref as string;
  const commits = payload.commits as Array<Record<string, unknown>> | undefined;

  console.log(`[Webhook] Push to ${ref}: ${commits?.length ?? 0} commits`);

  return c.json({
    message: "Push event processed",
    eventId,
    ref,
    commitCount: commits?.length ?? 0,
  });
}

// Handle Check Run/Suite event
async function handleCheckEvent(
  c: { json: (data: unknown, status?: number) => Response },
  action: string | undefined,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<Response> {
  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  const checkSuite = payload.check_suite as Record<string, unknown> | undefined;

  const conclusion = (checkRun?.conclusion as string) ?? (checkSuite?.conclusion as string);
  const status = (checkRun?.status as string) ?? (checkSuite?.status as string);

  console.log(`[Webhook] Check: ${action} - status=${status}, conclusion=${conclusion}`);

  // Notify Judge when CI completes
  if (status === "completed" && conclusion) {
    // Identify related PR and start Judge
    const pullRequests =
      (checkSuite?.pull_requests as Array<Record<string, unknown>>) ??
      (checkRun?.pull_requests as Array<Record<string, unknown>>) ??
      [];

    for (const pr of pullRequests) {
      const prNumber = pr.number as number;
      console.log(`[Webhook] CI ${conclusion} for PR #${prNumber}, Judge review may be triggered`);
    }
  }

  return c.json({
    message: "Check event processed",
    eventId,
    status,
    conclusion,
  });
}
