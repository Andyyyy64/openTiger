import { and, eq, inArray } from "drizzle-orm";
import { db } from "@openTiger/db";
import {
  artifacts,
  config as configTable,
  events,
  runs,
  tasks,
} from "@openTiger/db/schema";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseAllowedPathsFromIssueBody,
  parseDependencyIssueNumbersFromIssueBody,
  inferRoleFromLabels,
  inferRiskFromLabels,
  inferPriorityFromLabels,
  extractIssueNumberFromTaskContext,
} from "./system-issue-utils";
import {
  resolveGitHubContext,
  fetchOpenIssues,
  fetchOpenPrCount,
  type OpenIssueSnapshot,
} from "./system-preflight-github";

export function parseBooleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() !== "false";
}

export function parseCountSetting(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

type ConfigRow = typeof configTable.$inferSelect;

type TaskIssueLink = {
  id: string;
  status: string;
  updatedAt: Date;
};

export type SystemPreflightSummary = {
  github: {
    enabled: boolean;
    openIssueCount: number;
    openPrCount: number;
    issueTaskBacklogCount: number;
    generatedTaskCount: number;
    generatedTaskIds: string[];
    skippedIssueNumbers: number[];
    warnings: string[];
  };
  local: {
    queuedTaskCount: number;
    runningTaskCount: number;
    failedTaskCount: number;
    blockedTaskCount: number;
    pendingJudgeTaskCount: number;
  };
};

async function resolveIssueTaskCommands(): Promise<string[]> {
  const repoRoot = resolveRepoRoot();
  try {
    const raw = await readFile(join(repoRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    if (typeof scripts.check === "string") {
      return ["pnpm run check"];
    }
    if (typeof scripts.test === "string") {
      return ["pnpm test"];
    }
    if (typeof scripts.typecheck === "string") {
      return ["pnpm run typecheck"];
    }
  } catch {
    // Fallback to safe default if unable to retrieve
  }
  return ["pnpm -r --if-present test"];
}

async function createTaskFromIssue(
  issue: OpenIssueSnapshot,
  commands: string[],
  dependencyTaskIds: string[] = []
): Promise<string | null> {
  const allowedPaths = parseAllowedPathsFromIssueBody(issue.body);
  const role = inferRoleFromLabels(issue.labels);
  const riskLevel = inferRiskFromLabels(issue.labels);
  const priority = inferPriorityFromLabels(issue.labels);
  const notes = `Imported from GitHub Issue #${issue.number}`;

  const [created] = await db
    .insert(tasks)
    .values({
      title: issue.title,
      goal: `Resolve GitHub Issue #${issue.number} and make it closable via PR.`,
      context: {
        specs: issue.body || undefined,
        notes,
        issue: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
        },
      },
      allowedPaths,
      commands,
      dependencies: dependencyTaskIds,
      priority,
      riskLevel,
      role,
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!created?.id) {
    return null;
  }

  await db.insert(events).values({
    type: "task.created_from_issue",
    entityType: "task",
    entityId: created.id,
    agentId: "system",
    payload: {
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueTitle: issue.title,
      labels: issue.labels,
    },
  });

  return created.id;
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

function pickDependencyTaskId(links: TaskIssueLink[]): string | null {
  const statusWeight: Record<string, number> = {
    running: 0,
    queued: 1,
    blocked: 2,
    failed: 3,
  };

  const candidates = links
    .filter((link) => !isTerminalTaskStatus(link.status))
    .sort((a, b) => {
      const weightDiff = (statusWeight[a.status] ?? 99) - (statusWeight[b.status] ?? 99);
      if (weightDiff !== 0) {
        return weightDiff;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

  if (candidates.length === 0) {
    return null;
  }
  return candidates[0]?.id ?? null;
}

export async function buildPreflightSummary(options: {
  configRow: ConfigRow;
  autoCreateIssueTasks: boolean;
  autoCreatePrJudgeTasks: boolean;
}): Promise<SystemPreflightSummary> {
  const taskRows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      blockReason: tasks.blockReason,
      context: tasks.context,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks);

  let queuedTaskCount = 0;
  let runningTaskCount = 0;
  let failedTaskCount = 0;
  let blockedTaskCount = 0;
  let pendingJudgeTaskCount = 0;
  const issueTaskMap = new Map<number, TaskIssueLink[]>();

  for (const row of taskRows) {
    if (row.status === "queued") queuedTaskCount += 1;
    if (row.status === "running") runningTaskCount += 1;
    if (row.status === "failed") failedTaskCount += 1;
    if (row.status === "blocked") {
      blockedTaskCount += 1;
      if (row.blockReason === "awaiting_judge") {
        pendingJudgeTaskCount += 1;
      }
    }

    const issueNumber = extractIssueNumberFromTaskContext(row.context);
    if (!issueNumber) continue;
    const current = issueTaskMap.get(issueNumber) ?? [];
    current.push({
      id: row.id,
      status: row.status,
      updatedAt: row.updatedAt,
    });
    issueTaskMap.set(issueNumber, current);
  }

  const summary: SystemPreflightSummary = {
    github: {
      enabled: false,
      openIssueCount: 0,
      openPrCount: 0,
      issueTaskBacklogCount: 0,
      generatedTaskCount: 0,
      generatedTaskIds: [],
      skippedIssueNumbers: [],
      warnings: [],
    },
    local: {
      queuedTaskCount,
      runningTaskCount,
      failedTaskCount,
      blockedTaskCount,
      pendingJudgeTaskCount,
    },
  };

  if ((options.configRow.repoMode ?? "git").toLowerCase() !== "git") {
    summary.github.warnings.push("REPO_MODE is not git. Skipping GitHub issue/PR preflight.");
    return summary;
  }

  const githubContext = resolveGitHubContext(options.configRow);
  if (!githubContext) {
    summary.github.warnings.push(
      "GitHub token/owner/repo is not fully configured. Skipping issue and PR preflight."
    );
    return summary;
  }

  summary.github.enabled = true;
  let prLinkedIssueNumbers = new Set<number>();
  let openPulls: Array<{ number: number; title: string; body: string; url: string }> = [];

  let openIssues: OpenIssueSnapshot[] = [];
  try {
    const [issues, openPrSnapshot] = await Promise.all([
      fetchOpenIssues(githubContext),
      fetchOpenPrCount(githubContext),
    ]);
    openIssues = issues;
    summary.github.openIssueCount = issues.length;
    summary.github.openPrCount = openPrSnapshot.count;
    prLinkedIssueNumbers = openPrSnapshot.linkedIssueNumbers;
    openPulls = openPrSnapshot.openPulls;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.github.warnings.push(`Failed to query GitHub backlog: ${message}`);
    return summary;
  }

  const commands = options.autoCreateIssueTasks
    ? await resolveIssueTaskCommands()
    : [];
  const generatedIssueTaskIds = new Map<number, string>();

  for (const issue of openIssues) {
    if (prLinkedIssueNumbers.has(issue.number)) {
      summary.github.skippedIssueNumbers.push(issue.number);
      continue;
    }

    const linkedTasks = issueTaskMap.get(issue.number) ?? [];
    const isDone = linkedTasks.some((task) => task.status === "done");
    const hasOngoingTask = linkedTasks.some(
      (task) => task.status !== "done" && task.status !== "cancelled"
    );

    if (isDone) {
      summary.github.skippedIssueNumbers.push(issue.number);
      continue;
    }

    if (hasOngoingTask) {
      summary.github.issueTaskBacklogCount += 1;
      continue;
    }

    if (!options.autoCreateIssueTasks) {
      summary.github.issueTaskBacklogCount += 1;
      continue;
    }

    const createdTaskId = await createTaskFromIssue(issue, commands);
    if (createdTaskId) {
      generatedIssueTaskIds.set(issue.number, createdTaskId);
      const current = issueTaskMap.get(issue.number) ?? [];
      current.push({
        id: createdTaskId,
        status: "queued",
        updatedAt: new Date(),
      });
      issueTaskMap.set(issue.number, current);
      summary.github.generatedTaskCount += 1;
      summary.github.generatedTaskIds.push(createdTaskId);
      summary.github.issueTaskBacklogCount += 1;
    } else {
      summary.github.warnings.push(`Failed to create task for issue #${issue.number}.`);
    }
  }

  if (generatedIssueTaskIds.size > 0) {
    for (const issue of openIssues) {
      const taskId = generatedIssueTaskIds.get(issue.number);
      if (!taskId) {
        continue;
      }

      const dependencyIssueNumbers = parseDependencyIssueNumbersFromIssueBody(issue.body).filter(
        (number) => number !== issue.number
      );
      if (dependencyIssueNumbers.length === 0) {
        continue;
      }

      const dependencyTaskIds = Array.from(
        new Set(
          dependencyIssueNumbers
            .map((number) => pickDependencyTaskId(issueTaskMap.get(number) ?? []))
            .filter((value): value is string => Boolean(value))
        )
      );

      const missingIssueNumbers = dependencyIssueNumbers.filter(
        (number) => !issueTaskMap.has(number)
      );
      if (missingIssueNumbers.length > 0) {
        summary.github.warnings.push(
          `Issue #${issue.number} references missing dependencies: ${missingIssueNumbers
            .map((number) => `#${number}`)
            .join(", ")}`
        );
      }

      if (dependencyTaskIds.length === 0) {
        continue;
      }

      await db
        .update(tasks)
        .set({ dependencies: dependencyTaskIds, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      await db.insert(events).values({
        type: "task.dependencies_set_from_issue",
        entityType: "task",
        entityId: taskId,
        agentId: "system",
        payload: {
          issueNumber: issue.number,
          dependencyIssueNumbers,
          dependencyTaskIds,
        },
      });
    }
  }

  if (options.autoCreatePrJudgeTasks && openPulls.length > 0) {
    const openPrRefs = openPulls.map((pull) => String(pull.number));
    const trackedRows = await db
      .select({
        ref: artifacts.ref,
      })
      .from(artifacts)
      .where(and(eq(artifacts.type, "pr"), inArray(artifacts.ref, openPrRefs)));
    const trackedPrNumbers = new Set<number>();
    for (const row of trackedRows) {
      const parsed = Number.parseInt(row.ref ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        trackedPrNumbers.add(parsed);
      }
    }

    let importedPrCount = 0;
    for (const pull of openPulls) {
      if (trackedPrNumbers.has(pull.number)) {
        continue;
      }

      const [taskRow] = await db
        .insert(tasks)
        .values({
          title: `[PR] Review #${pull.number}: ${pull.title || "Untitled PR"}`,
          goal: `Review and process open PR #${pull.number}.`,
          context: {
            notes: "Imported from open GitHub PR backlog",
            pr: {
              number: pull.number,
              url: pull.url,
              title: pull.title,
            },
          },
          allowedPaths: ["**"],
          commands: [],
          dependencies: [],
          priority: 50,
          riskLevel: "low",
          role: "worker",
          status: "blocked",
          blockReason: "awaiting_judge",
          timeboxMinutes: 30,
        })
        .returning({ id: tasks.id });

      if (!taskRow?.id) {
        summary.github.warnings.push(`Failed to import open PR #${pull.number} into local backlog.`);
        continue;
      }

      const now = new Date();
      const [runRow] = await db
        .insert(runs)
        .values({
          taskId: taskRow.id,
          agentId: "system",
          status: "success",
          startedAt: now,
          finishedAt: now,
        })
        .returning({ id: runs.id });

      if (!runRow?.id) {
        summary.github.warnings.push(`Failed to create run for imported PR #${pull.number}.`);
        continue;
      }

      await db.insert(artifacts).values({
        runId: runRow.id,
        type: "pr",
        ref: String(pull.number),
        url: pull.url,
        metadata: {
          title: pull.title,
          imported: true,
        },
      });

      await db.insert(events).values({
        type: "task.created_from_open_pr",
        entityType: "task",
        entityId: taskRow.id,
        agentId: "system",
        payload: {
          prNumber: pull.number,
          prUrl: pull.url,
          prTitle: pull.title,
        },
      });

      importedPrCount += 1;
      summary.local.blockedTaskCount += 1;
      summary.local.pendingJudgeTaskCount += 1;
    }

    if (importedPrCount > 0) {
      summary.github.warnings.push(`Imported ${importedPrCount} open PR(s) into judge backlog.`);
    }
  }

  return summary;
}
