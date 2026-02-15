import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, buildConfigRecord } from "./system-config";

const LEGACY_REPLAN_COMMANDS = new Set([
  "",
  "pnpm --filter @openTiger/planner start",
  "pnpm --filter @sebastian-code/planner start",
]);

const DEFAULT_REPLAN_COMMAND = "pnpm --filter @openTiger/planner run start:fresh";
const execFileAsync = promisify(execFile);

type BootstrapHints = {
  replanWorkdir?: string;
  replanRequirementPath?: string;
  repoUrl?: string;
  githubOwner?: string;
  githubRepo?: string;
  baseBranch?: string;
};

let bootstrapHintsPromise: Promise<BootstrapHints> | null = null;

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(path: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    const info = await stat(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

async function detectWorkspaceRoot(startDir: string): Promise<string> {
  let currentDir = resolve(startDir);
  while (true) {
    if (await pathExists(resolve(currentDir, "pnpm-workspace.yaml"), "file")) {
      return currentDir;
    }
    if (
      (await pathExists(resolve(currentDir, ".git"), "dir")) ||
      (await pathExists(resolve(currentDir, ".git"), "file"))
    ) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return resolve(startDir);
    }
    currentDir = parentDir;
  }
}

type ParsedRemote = {
  repoUrl?: string;
  owner?: string;
  repo?: string;
};

function parseGitRemoteUrl(remoteUrl: string): ParsedRemote {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return {};
  }

  let host = "";
  let path = "";
  if (trimmed.startsWith("git@")) {
    const match = /^git@([^:]+):(.+)$/u.exec(trimmed);
    if (!match) {
      return {};
    }
    const matchedHost = match[1] ?? "";
    const matchedPath = match[2] ?? "";
    if (!matchedHost || !matchedPath) {
      return {};
    }
    host = matchedHost;
    path = matchedPath;
  } else if (trimmed.startsWith("ssh://")) {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      path = url.pathname.replace(/^\/+/u, "");
    } catch {
      return {};
    }
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      path = url.pathname.replace(/^\/+/u, "");
    } catch {
      return {};
    }
  }

  const normalizedPath = path.replace(/\.git$/u, "");
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const owner = segments.at(0);
  const repo = segments.at(1);
  if (!owner || !repo) {
    return { repoUrl: trimmed.replace(/\.git$/u, "") };
  }
  return {
    repoUrl: `https://${host}/${owner}/${repo}`,
    owner,
    repo,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function runGh(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      env: {
        ...process.env,
        GH_PAGER: "cat",
      },
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function parseGitHubLoginFromGhStatus(output: string): string | undefined {
  const line = output
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  if (!line) {
    return undefined;
  }

  const asMatch = /logged in to [^\s]+ as ([A-Za-z0-9-]+)/i.exec(output);
  if (asMatch?.[1]) {
    return asMatch[1];
  }

  const accountMatch = /account ([A-Za-z0-9-]+)/i.exec(output);
  return accountMatch?.[1];
}

async function resolveGithubOwnerFromGh(): Promise<string | undefined> {
  const login = await runGh(["api", "user", "--jq", ".login"]);
  if (isNonEmpty(login)) {
    return login;
  }
  const authStatus = await runGh(["auth", "status", "-h", "github.com"]);
  if (!isNonEmpty(authStatus)) {
    return undefined;
  }
  return parseGitHubLoginFromGhStatus(authStatus);
}

async function resolveBaseBranch(workspaceRoot: string): Promise<string | undefined> {
  const originHead = await runGit(workspaceRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (isNonEmpty(originHead)) {
    const splitIndex = originHead.lastIndexOf("/");
    return splitIndex >= 0 ? originHead.slice(splitIndex + 1) : originHead;
  }
  const currentBranch = await runGit(workspaceRoot, ["branch", "--show-current"]);
  return isNonEmpty(currentBranch) ? currentBranch : undefined;
}

async function resolveRequirementPath(
  workspaceRoot: string,
  replanWorkdir: string,
): Promise<string | undefined> {
  const fromEnv = process.env.REPLAN_REQUIREMENT_PATH?.trim();
  const candidates = [
    fromEnv,
    "docs/requirement.md",
    "templates/demo2_requirement.md",
    "templates/requirement.md",
    "templates/demo1_requirement.md",
    "requirement.md",
  ];
  for (const candidateRaw of candidates) {
    if (!isNonEmpty(candidateRaw)) {
      continue;
    }
    if (candidateRaw.startsWith("/")) {
      if (await pathExists(candidateRaw, "file")) {
        return candidateRaw;
      }
      continue;
    }
    if (await pathExists(resolve(replanWorkdir, candidateRaw), "file")) {
      return candidateRaw;
    }
    if (await pathExists(resolve(workspaceRoot, candidateRaw), "file")) {
      return candidateRaw;
    }
  }
  return undefined;
}

async function detectBootstrapHints(): Promise<BootstrapHints> {
  const workdirFromEnv = process.env.REPLAN_WORKDIR?.trim();
  const workspaceRoot = await detectWorkspaceRoot(
    isNonEmpty(workdirFromEnv) ? workdirFromEnv : process.cwd(),
  );
  const replanWorkdir = isNonEmpty(workdirFromEnv) ? resolve(workdirFromEnv) : workspaceRoot;

  const originUrl = await runGit(workspaceRoot, ["config", "--get", "remote.origin.url"]);
  const fromOrigin = isNonEmpty(originUrl) ? parseGitRemoteUrl(originUrl) : {};
  const repoUrlFromEnv = process.env.REPO_URL?.trim();
  const fromRepoEnv = isNonEmpty(repoUrlFromEnv) ? parseGitRemoteUrl(repoUrlFromEnv) : {};
  const baseBranchFromGit = await resolveBaseBranch(workspaceRoot);
  const ownerFromGh = await resolveGithubOwnerFromGh();
  const replanRequirementPath = await resolveRequirementPath(workspaceRoot, replanWorkdir);

  return {
    replanWorkdir,
    replanRequirementPath,
    repoUrl:
      fromRepoEnv.repoUrl ??
      (isNonEmpty(repoUrlFromEnv) ? repoUrlFromEnv : undefined) ??
      fromOrigin.repoUrl,
    githubOwner:
      process.env.GITHUB_OWNER?.trim() ||
      fromRepoEnv.owner ||
      fromOrigin.owner ||
      ownerFromGh ||
      undefined,
    githubRepo: process.env.GITHUB_REPO?.trim() || fromRepoEnv.repo || fromOrigin.repo || undefined,
    baseBranch: process.env.BASE_BRANCH?.trim() || baseBranchFromGit || undefined,
  };
}

async function getBootstrapHints(): Promise<BootstrapHints> {
  if (!bootstrapHintsPromise) {
    bootstrapHintsPromise = detectBootstrapHints();
  }
  return bootstrapHintsPromise;
}

async function createRequiredAutofillPatch(
  current: typeof configTable.$inferSelect,
): Promise<Partial<typeof configTable.$inferInsert> | null> {
  const hints = await getBootstrapHints();
  const patch: Partial<typeof configTable.$inferInsert> = {};

  const currentRequirementPath = current.replanRequirementPath?.trim() ?? "";
  const currentWorkdir =
    (isNonEmpty(current.replanWorkdir) ? resolve(current.replanWorkdir) : undefined) ??
    hints.replanWorkdir;
  const currentRequirementExists =
    isNonEmpty(currentRequirementPath) && isNonEmpty(currentWorkdir)
      ? await pathExists(
          currentRequirementPath.startsWith("/")
            ? currentRequirementPath
            : resolve(currentWorkdir, currentRequirementPath),
          "file",
        )
      : false;
  if (
    isNonEmpty(hints.replanRequirementPath) &&
    (!isNonEmpty(currentRequirementPath) ||
      (!currentRequirementExists && currentRequirementPath === "requirement.md"))
  ) {
    patch.replanRequirementPath = hints.replanRequirementPath;
  }

  if (!isNonEmpty(current.repoUrl) && isNonEmpty(hints.repoUrl)) {
    patch.repoUrl = hints.repoUrl;
  }
  if (!isNonEmpty(current.githubOwner) && isNonEmpty(hints.githubOwner)) {
    patch.githubOwner = hints.githubOwner;
  }
  if (!isNonEmpty(current.githubRepo) && isNonEmpty(hints.githubRepo)) {
    patch.githubRepo = hints.githubRepo;
  }
  if (!isNonEmpty(current.baseBranch) && isNonEmpty(hints.baseBranch)) {
    patch.baseBranch = hints.baseBranch;
  }

  if (Object.keys(patch).length === 0) {
    return null;
  }
  patch.updatedAt = new Date();
  return patch;
}

async function ensureConfigColumns(): Promise<void> {
  // Self-repair required columns so system_config works even if migration history is corrupted
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "execution_environment" text DEFAULT 'host' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_model" text DEFAULT 'gpt-5.3-codex' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_max_retries" text DEFAULT '3' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_retry_delay_ms" text DEFAULT '5000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_small_model" text DEFAULT 'google/gemini-2.5-flash' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "llm_executor" text DEFAULT 'claude_code' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "tester_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "docser_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_permission_mode" text DEFAULT 'bypassPermissions' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_model" text DEFAULT 'claude-opus-4-6' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_max_turns" text DEFAULT '0' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_allowed_tools" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_disallowed_tools" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_append_system_prompt" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_count" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_count" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_no_change_recovery_attempts" text DEFAULT '5' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_policy_recovery_attempts" text DEFAULT '5' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_recovery_attempts" text DEFAULT '5' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "blocked_needs_rework_in_place_retry_limit" text DEFAULT '5' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "github_auth_mode" text DEFAULT 'gh' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "tester_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "docser_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_setup_in_process_recovery" text DEFAULT 'true' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_llm_inline_recovery" text DEFAULT 'true' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_verify_llm_inline_recovery_attempts" text DEFAULT '3' NOT NULL`,
  );
}

function createLegacyNormalizationPatch(
  current: typeof configTable.$inferSelect,
): Partial<typeof configTable.$inferInsert> | null {
  const shouldNormalizeReplanCommand = LEGACY_REPLAN_COMMANDS.has(
    (current.replanCommand ?? "").trim(),
  );
  const shouldNormalizeMaxConcurrentWorkers = (current.maxConcurrentWorkers ?? "").trim() === "10";
  const shouldNormalizeDailyTokenLimit = (current.dailyTokenLimit ?? "").trim() === "50000000";
  const shouldNormalizeHourlyTokenLimit = (current.hourlyTokenLimit ?? "").trim() === "5000000";
  const shouldNormalizeTaskTokenLimit = (current.taskTokenLimit ?? "").trim() === "1000000";

  if (
    !shouldNormalizeReplanCommand &&
    !shouldNormalizeMaxConcurrentWorkers &&
    !shouldNormalizeDailyTokenLimit &&
    !shouldNormalizeHourlyTokenLimit &&
    !shouldNormalizeTaskTokenLimit
  ) {
    return null;
  }

  const patch: Partial<typeof configTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (shouldNormalizeReplanCommand) {
    patch.replanCommand = DEFAULT_REPLAN_COMMAND;
  }
  if (shouldNormalizeMaxConcurrentWorkers) {
    patch.maxConcurrentWorkers = "-1";
  }
  if (shouldNormalizeDailyTokenLimit) {
    patch.dailyTokenLimit = "-1";
  }
  if (shouldNormalizeHourlyTokenLimit) {
    patch.hourlyTokenLimit = "-1";
  }
  if (shouldNormalizeTaskTokenLimit) {
    patch.taskTokenLimit = "-1";
  }
  return patch;
}

export async function ensureConfigRow(): Promise<typeof configTable.$inferSelect> {
  await ensureConfigColumns();
  return await db.transaction(async (tx) => {
    // Ensure singleton row creation remains safe under concurrent boot requests.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(703614, 1)`);

    const existing = await tx.select().from(configTable).limit(1);
    const current = existing[0];
    if (current) {
      const legacyPatch = createLegacyNormalizationPatch(current);
      const requiredPatch = await createRequiredAutofillPatch(current);
      if (!legacyPatch && !requiredPatch) {
        return current;
      }
      const patch: Partial<typeof configTable.$inferInsert> = {};
      if (legacyPatch) {
        Object.assign(patch, legacyPatch);
      }
      if (requiredPatch) {
        Object.assign(patch, requiredPatch);
      }
      patch.updatedAt = new Date();
      const [updated] = await tx
        .update(configTable)
        .set(patch)
        .where(eq(configTable.id, current.id))
        .returning();
      return updated ?? current;
    }

    const created = await tx
      .insert(configTable)
      .values(buildConfigRecord(DEFAULT_CONFIG, { includeDefaults: true }))
      .returning();
    const row = created[0];
    if (!row) {
      throw new Error("Failed to create config");
    }
    const requiredPatch = await createRequiredAutofillPatch(row);
    if (!requiredPatch) {
      return row;
    }
    const [updated] = await tx
      .update(configTable)
      .set(requiredPatch)
      .where(eq(configTable.id, row.id))
      .returning();
    return updated ?? row;
  });
}
