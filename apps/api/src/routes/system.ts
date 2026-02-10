import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { ensureConfigRow } from "../config-store";
import { getAuthInfo } from "../middleware/index";
import { createRepo, getOctokit } from "@openTiger/vcs";
import { obliterateAllQueues } from "@openTiger/queue";
import { parseBooleanSetting, parseCountSetting, buildPreflightSummary } from "./system-preflight";
import { canControlSystem } from "./system-auth";
import { readRequirementFile, resolveRequirementPath } from "./system-requirements";
import { registerProcessManagerRoutes } from "./system-process-manager";

const systemRoute = new Hono();

registerProcessManagerRoutes(systemRoute);

systemRoute.get("/requirements", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const requirementPath = await resolveRequirementPath(c.req.query("path"), "requirement.md");
    const content = await readRequirementFile(requirementPath);
    return c.json({ path: requirementPath, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load requirement";
    return c.json({ error: message }, 400);
  }
});

systemRoute.post("/github/repo", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const ownerInput = typeof rawBody?.owner === "string" ? rawBody.owner.trim() : "";
  const repoInput = typeof rawBody?.repo === "string" ? rawBody.repo.trim() : "";
  const description = typeof rawBody?.description === "string" ? rawBody.description.trim() : "";
  const isPrivate = typeof rawBody?.private === "boolean" ? rawBody.private : true;

  const configRow = await ensureConfigRow();
  const owner = ownerInput || configRow.githubOwner;
  const repo = repoInput || configRow.githubRepo;
  const token = configRow.githubToken?.trim();

  if (!token) {
    return c.json({ error: "GitHub token is not configured" }, 400);
  }
  if (!owner) {
    return c.json({ error: "GitHub owner is required" }, 400);
  }
  if (!repo) {
    return c.json({ error: "GitHub repo is required" }, 400);
  }

  try {
    const info = await createRepo({
      token,
      owner,
      name: repo,
      description,
      private: isPrivate,
    });
    // Save post-creation configuration to DB to sync with UI state
    await db
      .update(configTable)
      .set({
        githubOwner: owner,
        githubRepo: repo,
        repoUrl: info.url,
        updatedAt: new Date(),
      })
      .where(eq(configTable.id, configRow.id));

    return c.json({ repo: info });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status)
        : undefined;
    const message = error instanceof Error ? error.message : "Failed to create repo";
    // Return reason to UI for insufficient permissions and prompt configuration
    if (status === 403 && message.includes("Resource not accessible")) {
      return c.json(
        {
          error:
            "GitHub token lacks permission to create repositories. " +
            "Ensure the token has repo permissions and org access if needed.",
        },
        403,
      );
    }
    return c.json({ error: message }, status === 403 ? 403 : 500);
  }
});

systemRoute.get("/github/repos", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const ownerFilter = c.req.query("owner")?.trim().toLowerCase();
  const configRow = await ensureConfigRow();
  const token = configRow.githubToken?.trim();
  if (!token) {
    return c.json({ error: "GitHub token is not configured" }, 400);
  }

  try {
    const octokit = getOctokit({ token });
    const rows = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
      per_page: 100,
    });

    const repos = rows
      .map((repo) => ({
        owner: repo.owner?.login ?? "",
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        defaultBranch: repo.default_branch ?? "main",
        private: repo.private,
        archived: repo.archived,
      }))
      .filter((repo) => repo.owner.length > 0)
      .filter((repo) =>
        ownerFilter ? repo.owner.toLowerCase() === ownerFilter || repo.fullName.includes(ownerFilter) : true,
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName));

    return c.json({ repos });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status)
        : undefined;
    const message = error instanceof Error ? error.message : "Failed to list repositories";
    return c.json({ error: message }, status === 401 || status === 403 ? status : 500);
  }
});

systemRoute.post("/preflight", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const content = typeof rawBody?.content === "string" ? rawBody.content : "";
    const autoCreateIssueTasks =
      typeof rawBody?.autoCreateIssueTasks === "boolean" ? rawBody.autoCreateIssueTasks : true;
    const hasRequirementContent = content.trim().length > 0;

    const configRow = await ensureConfigRow();
    const preflight = await buildPreflightSummary({
      configRow,
      autoCreateIssueTasks,
      autoCreatePrJudgeTasks: true,
    });

    const dispatcherEnabled = parseBooleanSetting(configRow.dispatcherEnabled, true);
    const judgeEnabled = parseBooleanSetting(configRow.judgeEnabled, true);
    const cycleManagerEnabled = parseBooleanSetting(configRow.cycleManagerEnabled, true);
    const workerCount = parseCountSetting(configRow.workerCount, 1);
    const testerCount = parseCountSetting(configRow.testerCount, 1);
    const docserCount = parseCountSetting(configRow.docserCount, 1);
    const judgeCount = parseCountSetting(configRow.judgeCount, 1);
    const plannerCount = Math.min(1, parseCountSetting(configRow.plannerCount, 1));

    const hasIssueBacklog = preflight.github.issueTaskBacklogCount > 0;
    const hasLocalTaskBacklog =
      preflight.local.queuedTaskCount > 0 ||
      preflight.local.runningTaskCount > 0 ||
      preflight.local.failedTaskCount > 0 ||
      preflight.local.blockedTaskCount > 0;
    const hasJudgeBacklog =
      preflight.github.openPrCount > 0 || preflight.local.pendingJudgeTaskCount > 0;

    const startPlanner = hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog;
    const startExecutionAgents = startPlanner || hasIssueBacklog || hasLocalTaskBacklog;

    const recommendations = {
      startPlanner,
      startDispatcher: dispatcherEnabled && startExecutionAgents,
      // Keep Judge running in cycles where execution agents are active
      startJudge: judgeEnabled && (hasJudgeBacklog || startExecutionAgents),
      plannerCount: startPlanner ? plannerCount : 0,
      judgeCount: judgeEnabled && (hasJudgeBacklog || startExecutionAgents) ? judgeCount : 0,
      startCycleManager:
        cycleManagerEnabled &&
        (startExecutionAgents || hasJudgeBacklog || preflight.local.blockedTaskCount > 0),
      workerCount: startExecutionAgents ? workerCount : 0,
      testerCount: startExecutionAgents ? testerCount : 0,
      docserCount: startExecutionAgents ? docserCount : 0,
      reasons: [
        hasIssueBacklog
          ? `Issue backlog detected (${preflight.github.issueTaskBacklogCount})`
          : "No issue backlog",
        hasJudgeBacklog
          ? `Judge backlog detected (openPR=${preflight.github.openPrCount}, awaitingJudge=${preflight.local.pendingJudgeTaskCount})`
          : "No judge backlog",
        parseCountSetting(configRow.plannerCount, 1) > 1
          ? "Planner count is capped at 1"
          : "Planner count is within limit",
        startPlanner
          ? "Planner is enabled because requirement content is present and issue/PR backlog is empty"
          : "Planner is skipped for this launch",
      ],
    };

    return c.json({
      preflight,
      recommendations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run preflight";
    return c.json({ error: message }, 500);
  }
});

systemRoute.post("/cleanup", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    // Delete all Redis queues to remove job remnants
    const queuesCleaned = await obliterateAllQueues();
    console.log(`[Cleanup] Obliterated ${queuesCleaned} queues`);

    // Allow DB-only reset even if processes are running
    await db.execute(sql`
      UPDATE agents
      SET current_task_id = NULL,
          status = 'idle',
          last_heartbeat = NOW()
    `);
    await db.execute(sql`
      TRUNCATE artifacts, runs, leases, events, cycles, tasks RESTART IDENTITY
      CASCADE
    `);
    return c.json({ cleaned: true, queuesObliterated: queuesCleaned });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
    return c.json({ error: message }, 500);
  }
});

export { systemRoute };
