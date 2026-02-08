import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { DOCSER_ALLOWED_PATHS } from "./task-policies";
import { pathIsDirectory, pathIsFile } from "./planner-utils";
import type { Requirement } from "./parser";
import type { PlannedTaskInput } from "./strategies/index";

type DocGapInfo = {
  docsMissing: boolean;
  docsEmpty: boolean;
  readmeMissing: boolean;
  docsReadmeMissing: boolean;
  hasGap: boolean;
};

export async function detectDocGap(workdir: string): Promise<DocGapInfo> {
  const docsPath = join(workdir, "docs");
  const docsMissing = !(await pathIsDirectory(docsPath));
  const readmeMissing = !(await pathIsFile(join(workdir, "README.md")));
  const docsReadmeMissing = !(await pathIsFile(join(workdir, "docs", "README.md")));

  let docsEmpty = false;
  if (!docsMissing) {
    try {
      const entries = await readdir(docsPath);
      docsEmpty = entries.filter((entry) => !entry.startsWith(".")).length === 0;
    } catch {
      docsEmpty = false;
    }
  }

  const hasGap = docsMissing || docsEmpty || readmeMissing || docsReadmeMissing;
  return { docsMissing, docsEmpty, readmeMissing, docsReadmeMissing, hasGap };
}

export async function hasPendingDocserTask(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.role, "docser"), inArray(tasks.status, ["queued", "running", "blocked"])))
      .limit(1);
    return Boolean(row);
  } catch (error) {
    console.warn("[Planner] Failed to check pending docser tasks:", error);
    return false;
  }
}

export function buildDocserTaskForGap(params: {
  requirement: Requirement;
  docGap: DocGapInfo;
  checkCommand?: string;
  dependsOnIndexes: number[];
}): PlannedTaskInput {
  const notes = [
    `要件: ${params.requirement.goal}`,
    "ドキュメント未整備を検知したためdocserで整備する。",
    `docGap: ${JSON.stringify(params.docGap)}`,
    "docs/README.md が存在しない場合は最小構成で作成する。",
  ].join("\n");
  const commands = params.checkCommand ? [params.checkCommand] : ["npm run check"];
  return {
    title: "ドキュメント整備",
    goal: "docs/README.md を含むドキュメントが実装と整合し、検証コマンドが成功する",
    role: "docser",
    context: {
      files: ["docs/README.md", "README.md", "docs/**"],
      notes,
    },
    allowedPaths: DOCSER_ALLOWED_PATHS,
    commands,
    priority: 5,
    riskLevel: "low",
    dependencies: [],
    dependsOnIndexes: params.dependsOnIndexes,
    timeboxMinutes: 45,
    targetArea: undefined,
    touches: [],
  };
}
