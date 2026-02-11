import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { db } from "@openTiger/db";
import { events } from "@openTiger/db/schema";
import { eq, desc, and, sql, gte } from "drizzle-orm";

const UNBORN_HEAD_SIGNATURE = "__UNBORN_HEAD__";

function isUnbornHeadError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("ambiguous argument 'head'") ||
    normalized.includes("unknown revision or path not in the working tree") ||
    normalized.includes("needed a single revision")
  );
}

async function computeRequirementHash(requirementPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(requirementPath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    console.warn("[Planner] Failed to read requirement file:", error);
    return;
  }
}

async function resolveRepoHeadSha(workdir: string): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        if (isUnbornHeadError(stderr)) {
          console.warn(
            "[Planner] Repository has no commits yet (unborn HEAD). Using placeholder for plan signature.",
          );
          resolveResult(UNBORN_HEAD_SIGNATURE);
          return;
        }
        console.warn("[Planner] git rev-parse failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }

      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha) {
        console.warn(
          "[Planner] git rev-parse returned empty HEAD; treating as unborn repository for signature.",
        );
        resolveResult(UNBORN_HEAD_SIGNATURE);
        return;
      }
      resolveResult(sha);
    });

    child.on("error", (error) => {
      console.warn("[Planner] git rev-parse error:", error);
      resolveResult(undefined);
    });
  });
}

export async function computePlanSignature(params: {
  requirementPath: string;
  workdir: string;
  repoUrl?: string;
  baseBranch: string;
}): Promise<{ signature: string; requirementHash: string; repoHeadSha: string } | undefined> {
  const requirementHash = await computeRequirementHash(params.requirementPath);
  if (!requirementHash) {
    return;
  }

  const repoHeadSha = await resolveRepoHeadSha(params.workdir);
  if (!repoHeadSha) {
    console.warn("[Planner] Failed to resolve repo HEAD for signature.");
    return;
  }

  const repoIdentity = params.repoUrl ? params.repoUrl : `local:${resolve(params.workdir)}`;
  const signaturePayload = {
    requirementHash,
    repoHeadSha,
    repoUrl: repoIdentity,
    baseBranch: params.baseBranch,
  };
  const signature = createHash("sha256").update(JSON.stringify(signaturePayload)).digest("hex");

  return { signature, requirementHash, repoHeadSha };
}

const DEFAULT_PLAN_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10分
type DbLike = typeof db;

export function resolvePlanDedupeWindowMs(): number {
  const raw = process.env.PLANNER_DEDUPE_WINDOW_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PLAN_DEDUPE_WINDOW_MS;
}

export async function wasPlanRecentlyCreated(
  signature: string,
  windowMs: number,
  database: DbLike = db,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await database
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, "planner.plan_created"),
        sql`${events.payload} ->> 'signature' = ${signature}`,
        gte(events.createdAt, since),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(1);
  return Boolean(row?.id);
}

function parsePgBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === "t" ||
      normalized === "true" ||
      normalized === "1" ||
      normalized === "y" ||
      normalized === "yes"
    );
  }
  return false;
}

function extractExecuteFirstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    const first = result[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }

  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const first = rows[0];
      return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
    }
  }

  return undefined;
}

export async function tryAcquirePlanSaveLock(
  signature: string,
  database: DbLike = db,
): Promise<boolean> {
  // 同一署名の保存を単一トランザクションに限定して、二重起動時の競合と重複保存を防ぐ
  const result = await database.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${signature})) AS locked`,
  );
  const row = extractExecuteFirstRow(result);
  if (!row || !("locked" in row)) {
    console.warn("[Planner] Could not parse advisory lock result; treat as not acquired.");
    return false;
  }
  return parsePgBoolean(row?.locked);
}
