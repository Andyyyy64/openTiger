import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getDocserAllowedPaths } from "./task-policies";
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
    `Requirement: ${params.requirement.goal}`,
    "Documentation gaps were detected and should be addressed by docser.",
    `docGap: ${JSON.stringify(params.docGap)}`,
    "If docs/README.md does not exist, create a minimal version.",
  ].join("\n");
  const commands = params.checkCommand ? [params.checkCommand] : [];
  return {
    title: "Documentation alignment",
    goal: "Ensure docs including docs/README.md match implementation and verification commands pass.",
    role: "docser",
    kind: "code",
    context: {
      files: ["docs/README.md", "README.md", "docs/**"],
      notes,
    },
    allowedPaths: getDocserAllowedPaths(),
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
