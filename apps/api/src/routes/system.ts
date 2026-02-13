import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { ensureConfigRow } from "../config-store";
import { getAuthInfo } from "../middleware/index";
import { createRepo, getOctokit, resolveGitHubAuthMode } from "@openTiger/vcs";
import { obliterateAllQueues } from "@openTiger/queue";
import { parseBooleanSetting, parseCountSetting, buildPreflightSummary } from "./system-preflight";
import { canControlSystem } from "./system-auth";
import {
  CANONICAL_REQUIREMENT_PATH,
  readRequirementFile,
  resolveRequirementRepoRoot,
  resolveRequirementPath,
  syncRequirementSnapshot,
} from "./system-requirements";
import { registerProcessManagerRoutes } from "./system-process-manager";
import { ensureHostSnapshot, formatNeofetchResponse } from "../system-context/host-snapshot";

const systemRoute = new Hono();

registerProcessManagerRoutes(systemRoute);

const CLAUDE_AUTH_FAILURE_MARKERS = [
  "/login",
  "authentication_failed",
  "does not have access to claude code",
  "api key source",
];
const CLAUDE_SANDBOX_RUNTIME_ERROR_MARKERS = [
  "cannot connect to the docker daemon",
  "permission denied while trying to connect to the docker daemon socket",
];
const CLAUDE_SANDBOX_IMAGE_ERROR_MARKERS = [
  "unable to find image",
  "pull access denied",
  "manifest unknown",
];
const CLAUDE_SANDBOX_CLI_MISSING_MARKERS = [
  "executable file not found in $path",
  "claude: not found",
];
const CODEX_AUTH_FAILURE_MARKERS = [
  "401 unauthorized",
  "missing bearer or basic authentication",
  "invalid_api_key",
  "run `codex login`",
];
const CODEX_SANDBOX_RUNTIME_ERROR_MARKERS = [
  "cannot connect to the docker daemon",
  "permission denied while trying to connect to the docker daemon socket",
];
const CODEX_SANDBOX_IMAGE_ERROR_MARKERS = [
  "unable to find image",
  "pull access denied",
  "manifest unknown",
];
const CODEX_SANDBOX_CLI_MISSING_MARKERS = [
  "executable file not found in $path",
  "codex: not found",
];

type ExecutionEnvironment = "host" | "sandbox";

function isClaudeAuthFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return CLAUDE_AUTH_FAILURE_MARKERS.some((marker) => normalized.includes(marker));
}

function includesAnyMarker(output: string, markers: string[]): boolean {
  const normalized = output.toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
}

function normalizeExecutionEnvironment(value: string | undefined): ExecutionEnvironment {
  return value?.trim().toLowerCase() === "sandbox" ? "sandbox" : "host";
}

function resolveSandboxDockerImage(): string {
  return process.env.SANDBOX_DOCKER_IMAGE ?? "openTiger/worker:latest";
}

function resolveSandboxDockerNetwork(): string {
  return process.env.SANDBOX_DOCKER_NETWORK ?? "bridge";
}

function resolveClaudeAuthMountArgs(): string[] {
  const hostHome = process.env.HOME?.trim();
  const claudeHomeOverride = process.env.CLAUDE_AUTH_DIR?.trim();
  const claudeConfigOverride = process.env.CLAUDE_CONFIG_DIR?.trim();
  const candidates = [
    claudeHomeOverride
      ? {
          hostPath: resolve(claudeHomeOverride),
          containerPath: "/home/worker/.claude",
        }
      : null,
    claudeConfigOverride
      ? {
          hostPath: resolve(claudeConfigOverride),
          containerPath: "/home/worker/.config/claude",
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".claude"),
          containerPath: "/home/worker/.claude",
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".config", "claude"),
          containerPath: "/home/worker/.config/claude",
        }
      : null,
  ];
  const mountArgs: string[] = [];
  const seenContainerPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (seenContainerPaths.has(candidate.containerPath)) {
      continue;
    }
    if (!existsSync(candidate.hostPath)) {
      continue;
    }
    mountArgs.push("--volume", `${candidate.hostPath}:${candidate.containerPath}:ro`);
    seenContainerPaths.add(candidate.containerPath);
  }
  return mountArgs;
}

function resolveCodexAuthMountArgs(): string[] {
  const hostHome = process.env.HOME?.trim();
  const codexAuthOverride = process.env.CODEX_AUTH_DIR?.trim();
  const candidates = [
    codexAuthOverride
      ? {
          hostPath: resolve(codexAuthOverride),
          containerPath: "/home/worker/.codex",
        }
      : null,
    hostHome
      ? {
          hostPath: join(hostHome, ".codex"),
          containerPath: "/home/worker/.codex",
        }
      : null,
  ];
  const mountArgs: string[] = [];
  const seenContainerPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (seenContainerPaths.has(candidate.containerPath)) {
      continue;
    }
    if (!existsSync(candidate.hostPath)) {
      continue;
    }
    mountArgs.push("--volume", `${candidate.hostPath}:${candidate.containerPath}:ro`);
    seenContainerPaths.add(candidate.containerPath);
  }
  return mountArgs;
}

function runClaudeAuthCheck(environment: ExecutionEnvironment) {
  if (environment === "sandbox") {
    const dockerArgs = [
      "run",
      "--rm",
      "--network",
      resolveSandboxDockerNetwork(),
      "--add-host",
      "host.docker.internal:host-gateway",
      ...resolveClaudeAuthMountArgs(),
      resolveSandboxDockerImage(),
      "claude",
      "-p",
      "Respond with exactly OK.",
      "--output-format",
      "text",
    ];
    return spawnSync("docker", dockerArgs, {
      encoding: "utf-8",
      timeout: 20000,
    });
  }
  return spawnSync("claude", ["-p", "Respond with exactly OK.", "--output-format", "text"], {
    encoding: "utf-8",
    timeout: 15000,
  });
}

function runCodexAuthCheck(environment: ExecutionEnvironment, openaiApiKey: string) {
  const resolvedOpenAiApiKey = openaiApiKey.trim() || process.env.OPENAI_API_KEY;
  if (environment === "sandbox") {
    const dockerArgs = [
      "run",
      "--rm",
      "--network",
      resolveSandboxDockerNetwork(),
      "--add-host",
      "host.docker.internal:host-gateway",
      ...resolveCodexAuthMountArgs(),
      resolveSandboxDockerImage(),
      "codex",
      "exec",
      "--skip-git-repo-check",
      "Respond with exactly OK.",
    ];
    return spawnSync("docker", dockerArgs, {
      encoding: "utf-8",
      timeout: 20000,
      env: {
        ...process.env,
        OPENAI_API_KEY: resolvedOpenAiApiKey,
      },
    });
  }
  return spawnSync("codex", ["exec", "--skip-git-repo-check", "Respond with exactly OK."], {
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      OPENAI_API_KEY: resolvedOpenAiApiKey,
    },
  });
}

function isCodexAuthFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return CODEX_AUTH_FAILURE_MARKERS.some((marker) => normalized.includes(marker));
}

systemRoute.get("/claude/auth", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const configRow = await ensureConfigRow();
  const requestedEnvironment = normalizeExecutionEnvironment(c.req.query("environment"));
  const executionEnvironment =
    c.req.query("environment") !== undefined
      ? requestedEnvironment
      : normalizeExecutionEnvironment(
          configRow.executionEnvironment ?? process.env.EXECUTION_ENVIRONMENT,
        );
  const result = runClaudeAuthCheck(executionEnvironment);
  const checkedAt = new Date().toISOString();
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const combined = `${stdout}\n${stderr}`.trim();

  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message:
          executionEnvironment === "sandbox"
            ? "Docker command was not found. Install Docker and ensure the daemon is available."
            : "Claude Code CLI was not found. Install Claude Code CLI and complete `/login` first.",
      });
    }
    return c.json({
      available: false,
      authenticated: false,
      executionEnvironment,
      checkedAt,
      message: `Failed to check Claude Code auth: ${result.error.message}`,
    });
  }

  if (executionEnvironment === "sandbox") {
    if (includesAnyMarker(combined, CLAUDE_SANDBOX_RUNTIME_ERROR_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message: "Docker daemon is not reachable. Check Docker Desktop / dockerd status.",
      });
    }
    if (includesAnyMarker(combined, CLAUDE_SANDBOX_IMAGE_ERROR_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message:
          "Sandbox worker image is unavailable. Build or pull SANDBOX_DOCKER_IMAGE (default: openTiger/worker:latest).",
      });
    }
    if (includesAnyMarker(combined, CLAUDE_SANDBOX_CLI_MISSING_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message:
          "Claude CLI is not installed in sandbox image. Rebuild worker image with @anthropic-ai/claude-code.",
      });
    }
  }

  if (isClaudeAuthFailure(combined)) {
    return c.json({
      available: true,
      authenticated: false,
      executionEnvironment,
      checkedAt,
      message:
        executionEnvironment === "sandbox"
          ? "Claude Code is not authenticated in sandbox. Run `claude /login` on host and mount Claude auth directories."
          : "Claude Code is not authenticated. Run `claude` and complete `/login`.",
    });
  }

  if (result.status === 0) {
    return c.json({
      available: true,
      authenticated: true,
      executionEnvironment,
      checkedAt,
    });
  }

  // Avoid false-positive warnings when auth failure is not explicit
  return c.json({
    available: true,
    authenticated: true,
    executionEnvironment,
    checkedAt,
    message:
      "Claude auth check returned a non-auth error; skipping warning to avoid false positives.",
  });
});

systemRoute.get("/codex/auth", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const configRow = await ensureConfigRow();
  const requestedEnvironment = normalizeExecutionEnvironment(c.req.query("environment"));
  const executionEnvironment =
    c.req.query("environment") !== undefined
      ? requestedEnvironment
      : normalizeExecutionEnvironment(
          configRow.executionEnvironment ?? process.env.EXECUTION_ENVIRONMENT,
        );
  const result = runCodexAuthCheck(executionEnvironment, configRow.openaiApiKey ?? "");
  const checkedAt = new Date().toISOString();
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const combined = `${stdout}\n${stderr}`.trim();

  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message:
          executionEnvironment === "sandbox"
            ? "Docker command was not found. Install Docker and ensure the daemon is available."
            : "Codex CLI was not found. Install `@openai/codex` and authenticate first.",
      });
    }
    return c.json({
      available: false,
      authenticated: false,
      executionEnvironment,
      checkedAt,
      message: `Failed to check Codex auth: ${result.error.message}`,
    });
  }

  if (executionEnvironment === "sandbox") {
    if (includesAnyMarker(combined, CODEX_SANDBOX_RUNTIME_ERROR_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message: "Docker daemon is not reachable. Check Docker Desktop / dockerd status.",
      });
    }
    if (includesAnyMarker(combined, CODEX_SANDBOX_IMAGE_ERROR_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message:
          "Sandbox worker image is unavailable. Build or pull SANDBOX_DOCKER_IMAGE (default: openTiger/worker:latest).",
      });
    }
    if (includesAnyMarker(combined, CODEX_SANDBOX_CLI_MISSING_MARKERS)) {
      return c.json({
        available: false,
        authenticated: false,
        executionEnvironment,
        checkedAt,
        message: "Codex CLI is not installed in sandbox image. Rebuild worker image with @openai/codex.",
      });
    }
  }

  if (isCodexAuthFailure(combined)) {
    return c.json({
      available: true,
      authenticated: false,
      executionEnvironment,
      checkedAt,
      message:
        executionEnvironment === "sandbox"
          ? "Codex is not authenticated in sandbox. Run `codex login` on host and mount ~/.codex, or set OPENAI_API_KEY."
          : "Codex is not authenticated. Run `codex login` or set OPENAI_API_KEY.",
    });
  }

  if (result.status === 0) {
    return c.json({
      available: true,
      authenticated: true,
      executionEnvironment,
      checkedAt,
    });
  }

  return c.json({
    available: true,
    authenticated: true,
    executionEnvironment,
    checkedAt,
    message: "Codex auth check returned a non-auth error; skipping warning to avoid false positives.",
  });
});

systemRoute.get("/github/auth", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const configRow = await ensureConfigRow();
  const authMode = resolveGitHubAuthMode(configRow.githubAuthMode);
  const checkedAt = new Date().toISOString();
  if (authMode !== "gh") {
    return c.json({
      available: true,
      authenticated: true,
      mode: authMode,
      checkedAt,
      message: "GitHub auth mode is token. `gh` readiness check is skipped.",
    });
  }

  const result = spawnSync("gh", ["auth", "status", "-h", "github.com"], {
    env: {
      ...process.env,
      GH_PAGER: "cat",
    },
    encoding: "utf-8",
    timeout: 10000,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const detail = [stdout, stderr].filter((value) => value.length > 0).join("\n");

  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return c.json({
        available: false,
        authenticated: false,
        mode: authMode,
        checkedAt,
        message: "GitHub CLI was not found. Install `gh` and run `gh auth login`.",
      });
    }
    return c.json({
      available: false,
      authenticated: false,
      mode: authMode,
      checkedAt,
      message: `Failed to check GitHub CLI auth: ${result.error.message}`,
    });
  }

  if (result.status === 0) {
    return c.json({
      available: true,
      authenticated: true,
      mode: authMode,
      checkedAt,
    });
  }

  return c.json({
    available: true,
    authenticated: false,
    mode: authMode,
    checkedAt,
    message:
      detail.length > 0
        ? `GitHub CLI is not authenticated. Run \`gh auth login\`. (${detail})`
        : "GitHub CLI is not authenticated. Run `gh auth login`.",
  });
});

systemRoute.get("/host/neofetch", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const { snapshot } = await ensureHostSnapshot();
    return c.json(formatNeofetchResponse(snapshot));
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Failed to resolve host snapshot";
    return c.json({
      available: false,
      checkedAt,
      message,
    });
  }
});

systemRoute.get("/host/context", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const { snapshot, refreshed } = await ensureHostSnapshot();
    return c.json({
      refreshed,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve host context";
    return c.json({ error: message }, 500);
  }
});

systemRoute.get("/requirements", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  try {
    const configRow = await ensureConfigRow();
    const requirementRepoRoot = await resolveRequirementRepoRoot({
      repoMode: configRow.repoMode,
      localRepoPath: configRow.localRepoPath,
      replanWorkdir: configRow.replanWorkdir,
      repoUrl: configRow.repoUrl,
      githubOwner: configRow.githubOwner,
      githubRepo: configRow.githubRepo,
      githubAuthMode: configRow.githubAuthMode,
      githubToken: configRow.githubToken,
    });
    const requirementPath = await resolveRequirementPath(
      c.req.query("path"),
      CANONICAL_REQUIREMENT_PATH,
      { repoRoot: requirementRepoRoot },
    );
    const content = await readRequirementFile(requirementPath);
    return c.json({ path: requirementPath, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load requirement";
    return c.json({ error: message }, 400);
  }
});

systemRoute.post("/requirements", async (c) => {
  const auth = getAuthInfo(c);
  if (!canControlSystem(auth.method)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const path = typeof rawBody?.path === "string" ? rawBody.path : undefined;
  const content = typeof rawBody?.content === "string" ? rawBody.content : "";
  if (content.trim().length === 0) {
    return c.json({ error: "Requirement content is empty" }, 400);
  }

  try {
    const configRow = await ensureConfigRow();
    const requirementRepoRoot = await resolveRequirementRepoRoot({
      repoMode: configRow.repoMode,
      localRepoPath: configRow.localRepoPath,
      replanWorkdir: configRow.replanWorkdir,
      repoUrl: configRow.repoUrl,
      githubOwner: configRow.githubOwner,
      githubRepo: configRow.githubRepo,
      githubAuthMode: configRow.githubAuthMode,
      githubToken: configRow.githubToken,
    });
    const result = await syncRequirementSnapshot({
      inputPath: path,
      content,
      commitSnapshot: true,
      repoRoot: requirementRepoRoot,
    });
    if (configRow.replanRequirementPath.trim() !== CANONICAL_REQUIREMENT_PATH) {
      await db
        .update(configTable)
        .set({
          replanRequirementPath: CANONICAL_REQUIREMENT_PATH,
          updatedAt: new Date(),
        })
        .where(eq(configTable.id, configRow.id));
    }
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save requirement";
    return c.json({ error: message }, 500);
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
  const authMode = resolveGitHubAuthMode(configRow.githubAuthMode);

  if (authMode === "token" && !token) {
    return c.json({ error: "GITHUB_TOKEN is required when GITHUB_AUTH_MODE is token" }, 400);
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
      authMode,
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
  const authMode = resolveGitHubAuthMode(configRow.githubAuthMode);
  if (authMode === "token" && !token) {
    return c.json({ error: "GITHUB_TOKEN is required when GITHUB_AUTH_MODE is token" }, 400);
  }

  try {
    const octokit = getOctokit({
      token,
      authMode,
    });
    const viewer = await octokit.users.getAuthenticated();
    const viewerLogin = viewer.data.login?.trim() ?? "";
    const effectiveOwnerFilter = (ownerFilter || viewerLogin).toLowerCase();
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
        updatedAt: repo.updated_at ?? repo.pushed_at ?? "",
      }))
      .filter((repo) => repo.owner.length > 0)
      .filter((repo) =>
        effectiveOwnerFilter
          ? repo.owner.toLowerCase() === effectiveOwnerFilter ||
            repo.fullName.toLowerCase().includes(`${effectiveOwnerFilter}/`)
          : true,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    console.info(
      `[System] github repos resolved ownerFilter=${ownerFilter ?? "-"} viewer=${viewerLogin || "-"} effective=${effectiveOwnerFilter || "-"} count=${repos.length}`,
    );
    return c.json({ repos, viewerLogin });
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

    const startPlanner =
      hasRequirementContent && !hasIssueBacklog && !hasJudgeBacklog && !hasLocalTaskBacklog;
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
          ? "Planner is enabled because requirement content is present and local/issue/PR backlog is empty"
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
