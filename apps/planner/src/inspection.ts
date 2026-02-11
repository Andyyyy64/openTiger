import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { runOpenCode } from "@openTiger/llm";
import type { Requirement } from "./parser";
import { getPlannerOpenCodeEnv } from "./opencode-config";
import { extractJsonObjectFromText } from "./json-response";

export interface CodebaseInspection {
  summary: string;
  satisfied: string[];
  gaps: string[];
  evidence: string[];
  notes: string[];
}

interface FileExcerpt {
  path: string;
  excerpt: string;
  truncated: boolean;
}

interface RepoSnapshot {
  topLevel: string[];
  fileList: string[];
  matchedFiles: string[];
  unmatchedAllowedPaths: string[];
  excerpts: FileExcerpt[];
  readme?: string;
  architecture?: string;
}

const MAX_FILES = 2000;
const MAX_README_CHARS = 3000;
const MAX_ARCH_CHARS = 3000;
const MAX_EXCERPT_FILES = 40;
const MAX_EXCERPT_CHARS = 4000;
const MAX_TOTAL_EXCERPT_CHARS = 45000;
const MAX_EXCERPT_LINES = 240;
const HEAD_EXCERPT_LINES = 120;
const TAIL_EXCERPT_LINES = 120;

const EXCERPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
]);

async function readOptionalFile(path: string, maxChars: number): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    return content.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

async function listTrackedFiles(workdir: string, limit: number): Promise<string[]> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["ls-files"], {
      cwd: workdir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolveResult([]);
        return;
      }
      const files = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, limit);
      resolveResult(files);
    });

    child.on("error", () => resolveResult([]));
  });
}

function normalizeAllowedPath(pattern: string): string {
  if (!pattern) {
    return pattern;
  }
  if (pattern.endsWith("/")) {
    return `${pattern}**`;
  }
  return pattern;
}

function matchPath(path: string, pattern: string): boolean {
  let regexPattern = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (!char) {
      continue;
    }
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexPattern += ".*";
        i++;
        continue;
      }
      regexPattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      regexPattern += ".";
      continue;
    }
    regexPattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regexPattern}$`).test(path);
}

function isExcerptTarget(path: string): boolean {
  if (path.endsWith("README.md")) {
    return true;
  }
  return EXCERPT_EXTENSIONS.has(extname(path).toLowerCase());
}

function filterFilesByAllowedPaths(
  fileList: string[],
  allowedPaths: string[],
): { matchedFiles: string[]; unmatchedAllowedPaths: string[] } {
  if (allowedPaths.length === 0) {
    return { matchedFiles: fileList, unmatchedAllowedPaths: [] };
  }

  const normalized = allowedPaths.map((pattern) => normalizeAllowedPath(pattern));
  const matchedFiles = fileList.filter((file) =>
    normalized.some((pattern) => matchPath(file, pattern)),
  );
  const unmatchedAllowedPaths = normalized.filter(
    (pattern) => !fileList.some((file) => matchPath(file, pattern)),
  );

  return { matchedFiles, unmatchedAllowedPaths };
}

function formatExcerptLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index + 1}|${line}`).join("\n");
}

function buildExcerpt(content: string): { excerpt: string; truncated: boolean } {
  const lines = content.split("\n");
  if (lines.length <= MAX_EXCERPT_LINES) {
    return { excerpt: formatExcerptLines(lines, 0), truncated: false };
  }

  const head = lines.slice(0, HEAD_EXCERPT_LINES);
  const tail = lines.slice(-TAIL_EXCERPT_LINES);
  const excerpt = [
    formatExcerptLines(head, 0),
    "...",
    formatExcerptLines(tail, lines.length - tail.length),
  ].join("\n");

  return { excerpt, truncated: true };
}

async function buildFileExcerpts(workdir: string, files: string[]): Promise<FileExcerpt[]> {
  const excerpts: FileExcerpt[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (excerpts.length >= MAX_EXCERPT_FILES) {
      break;
    }
    const remaining = MAX_TOTAL_EXCERPT_CHARS - totalChars;
    if (remaining <= 0) {
      break;
    }

    try {
      const content = await readFile(join(workdir, file), "utf-8");
      if (content.includes("\u0000")) {
        continue;
      }
      const { excerpt, truncated } = buildExcerpt(content);
      const limitedExcerpt =
        excerpt.length > Math.min(MAX_EXCERPT_CHARS, remaining)
          ? `${excerpt.slice(0, Math.min(MAX_EXCERPT_CHARS, remaining))}\n...`
          : excerpt;
      const finalTruncated = truncated || limitedExcerpt.length < excerpt.length;
      if (!limitedExcerpt) {
        continue;
      }
      excerpts.push({
        path: file,
        excerpt: limitedExcerpt,
        truncated: finalTruncated,
      });
      totalChars += limitedExcerpt.length;
    } catch {
      continue;
    }
  }

  return excerpts;
}

async function buildRepoSnapshot(workdir: string, requirement: Requirement): Promise<RepoSnapshot> {
  const entries = await readdir(workdir, { withFileTypes: true });
  const topLevel = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  const [fileList, readme, architecture] = await Promise.all([
    listTrackedFiles(workdir, MAX_FILES),
    readOptionalFile(join(workdir, "README.md"), MAX_README_CHARS),
    readOptionalFile(join(workdir, "docs/architecture.md"), MAX_ARCH_CHARS),
  ]);

  // Collect files matching allowed paths and excerpts for inspection evidence
  const { matchedFiles, unmatchedAllowedPaths } = filterFilesByAllowedPaths(
    fileList,
    requirement.allowedPaths,
  );
  const excerptTargets = matchedFiles.filter((file) => isExcerptTarget(file));
  const excerpts = await buildFileExcerpts(
    workdir,
    excerptTargets.length > 0 ? excerptTargets : matchedFiles,
  );

  return {
    topLevel,
    fileList,
    matchedFiles,
    unmatchedAllowedPaths,
    excerpts,
    readme,
    architecture,
  };
}

function buildInspectionPrompt(requirement: Requirement, snapshot: RepoSnapshot): string {
  const readmeBlock = snapshot.readme ? `\n## README (Excerpt)\n${snapshot.readme}` : "";
  const architectureBlock = snapshot.architecture
    ? `\n## docs/architecture.md (Excerpt)\n${snapshot.architecture}`
    : "";

  const allowedPathBlock =
    snapshot.unmatchedAllowedPaths.length > 0
      ? `\nUnmatched allowedPaths:\n${snapshot.unmatchedAllowedPaths.map((path) => `- ${path}`).join("\n")}`
      : "\nUnmatched allowedPaths:\n(none)";
  const excerptBlock =
    snapshot.excerpts.length > 0
      ? snapshot.excerpts
          .map(
            (excerpt) =>
              `### ${excerpt.path}${excerpt.truncated ? " (truncated)" : ""}\n\`\`\`\n${excerpt.excerpt}\n\`\`\``,
          )
          .join("\n\n")
      : "(No relevant files were found.)";

  return `
You are an expert in auditing requirement-to-implementation gaps.
Read the requirement and repository snapshot below, then identify possible missing, insufficient, or contradictory implementations.
This task is gap inspection, not task planning.
Do not call tools. Reason only from the information provided here.
You must use the provided code excerpts as evidence. If no gap is found, return an empty gaps array.
Excerpts include line numbers, so cite evidence in the form "path: line|content".
If something is not present in excerpts, treat it as unverified and do not include it as a gap.

## Requirement
### Goal
${requirement.goal}

### Acceptance Criteria
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

### Constraints
${requirement.constraints.length > 0 ? requirement.constraints.map((c) => `- ${c}`).join("\n") : "(none)"}

### Scope
In Scope:
${requirement.scope.inScope.map((s) => `- ${s}`).join("\n") || "(none)"}

Out of Scope:
${requirement.scope.outOfScope.map((s) => `- ${s}`).join("\n") || "(none)"}

### Allowed Paths
${requirement.allowedPaths.map((p) => `- ${p}`).join("\n")}

### Notes
${requirement.notes || "(none)"}

## Repository Snapshot
Top-level:
${snapshot.topLevel.map((name) => `- ${name}`).join("\n")}

Tracked files (first ${snapshot.fileList.length}):
${snapshot.fileList.map((file) => `- ${file}`).join("\n")}
${readmeBlock}
${architectureBlock}
Allowed paths coverage:
- Matched files: ${snapshot.matchedFiles.length} / ${snapshot.fileList.length}
${allowedPathBlock}

## Relevant file excerpts
${excerptBlock}

## Output Format
Return JSON only. Do not include any extra text.

\`\`\`json
{
  "summary": "Overall gap summary in 1-2 sentences",
  "satisfied": [
    "Requirements or acceptance criteria already satisfied"
  ],
  "gaps": [
    "Potential missing, insufficient, or contradictory implementation",
    "Mismatch against acceptance criteria"
  ],
  "evidence": [
    "Supporting evidence (path: reason)"
  ],
  "notes": [
    "Notes and caveats about the gap judgment"
  ]
}
\`\`\`
`.trim();
}

function isInspectionPayload(value: unknown): value is {
  summary?: string;
  satisfied?: string[];
  gaps?: string[];
  evidence?: string[];
  notes?: string[];
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { summary?: unknown; gaps?: unknown };
  return typeof record.summary === "string" || Array.isArray(record.gaps);
}

// LLM call timeout per attempt (seconds)
const PER_ATTEMPT_TIMEOUT_SECONDS = 120;
// Retry limit on no response (-1 = unlimited)
const INSPECTION_MAX_RETRIES = (() => {
  const parsed = Number.parseInt(process.env.PLANNER_INSPECT_MAX_RETRIES ?? "-1", 10);
  return Number.isFinite(parsed) ? parsed : -1;
})();
// Wait time on quota exceeded before retry (fixed interval to avoid blocking recovery)
const INSPECTION_QUOTA_RETRY_DELAY_MS = (() => {
  const parsed = Number.parseInt(process.env.PLANNER_INSPECT_QUOTA_RETRY_DELAY_MS ?? "30000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30000;
})();

// Use Promise.race to force abort if runOpenCode hangs internally
function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: hard timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isQuotaExceededMessage(message: string): boolean {
  return /quota exceeded|exceeded your current quota|generate_requests_per_model_per_day|resource_exhausted/i.test(
    message,
  );
}

function isUnlimitedInspectionRetry(): boolean {
  return INSPECTION_MAX_RETRIES < 0;
}

function formatInspectionRetryLimit(): string {
  if (isUnlimitedInspectionRetry()) {
    return "inf";
  }
  return String(Math.max(0, INSPECTION_MAX_RETRIES - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function inspectCodebase(
  requirement: Requirement,
  options: {
    workdir: string;
    timeoutSeconds?: number;
  },
): Promise<CodebaseInspection | undefined> {
  const snapshot = await buildRepoSnapshot(options.workdir, requirement);
  const prompt = buildInspectionPrompt(requirement, snapshot);

  const model = process.env.PLANNER_INSPECT_MODEL ?? process.env.PLANNER_MODEL;
  const totalTimeout = options.timeoutSeconds ?? 180;
  const hasDeadline = Number.isFinite(totalTimeout) && totalTimeout > 0;
  // Adjust per-attempt timeout to fit within total budget
  const perAttemptTimeout = hasDeadline
    ? Math.min(PER_ATTEMPT_TIMEOUT_SECONDS, Math.floor(totalTimeout / 2))
    : PER_ATTEMPT_TIMEOUT_SECONDS;
  const deadline = hasDeadline ? Date.now() + totalTimeout * 1000 : null;

  let lastError = "";
  let attempts = 0;
  for (
    let attempt = 0;
    isUnlimitedInspectionRetry() || attempt < INSPECTION_MAX_RETRIES;
    attempt++
  ) {
    const remaining = deadline ? Math.floor((deadline - Date.now()) / 1000) : null;
    if (remaining !== null && remaining <= 10) {
      console.warn("[Planner] Inspection deadline reached, giving up.");
      break;
    }

    const attemptTimeout =
      remaining !== null ? Math.min(perAttemptTimeout, remaining) : perAttemptTimeout;
    if (attempt > 0) {
      console.log(
        `[Planner] Inspection retry ${attempt}/${formatInspectionRetryLimit()} (timeout: ${attemptTimeout}s)`,
      );
    }
    attempts = attempt + 1;

    try {
      // Force-abort runOpenCode promise if opencode process ignores SIGTERM/SIGKILL and hangs
      const hardTimeoutMs = (attemptTimeout + 10) * 1000;
      const result = await withHardTimeout(
        runOpenCode({
          workdir: options.workdir,
          task: prompt,
          model,
          timeoutSeconds: attemptTimeout,
          // Disable retries inside runOpenCode; control them here instead
          maxRetries: 0,
          // Disable tools to avoid Gemini 3 function-calling constraints
          env: getPlannerOpenCodeEnv(),
        }),
        hardTimeoutMs,
        "Inspection",
      );

      if (result.success && result.stdout.trim().length > 0) {
        return parseInspectionResult(result.stdout);
      }

      lastError = result.stderr || `exit code ${result.exitCode}`;
      if (isQuotaExceededMessage(lastError)) {
        console.warn("[Planner] Quota limit hit; waiting before retrying inspection.");
        await sleep(INSPECTION_QUOTA_RETRY_DELAY_MS);
        continue;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isQuotaExceededMessage(lastError)) {
        console.warn("[Planner] Quota limit hit; waiting before retrying inspection.");
        await sleep(INSPECTION_QUOTA_RETRY_DELAY_MS);
        continue;
      }
    }

    console.warn(`[Planner] Inspection attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
  }

  console.warn(
    `[Planner] Codebase inspection failed after ${attempts} attempts: ${lastError.slice(0, 200)}`,
  );
  return;
}

function parseInspectionResult(stdout: string): CodebaseInspection {
  const parsed = extractJsonObjectFromText(stdout, isInspectionPayload);

  let gaps = Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === "string") : [];
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((item) => typeof item === "string")
    : [];
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((n) => typeof n === "string")
    : [];

  if (gaps.length > 0 && evidence.length === 0) {
    gaps = [];
    notes.push("Insufficient evidence to confirm implementation gaps.");
  }

  return {
    summary:
      typeof parsed.summary === "string" ? parsed.summary : "No inspection summary was provided.",
    satisfied: Array.isArray(parsed.satisfied)
      ? parsed.satisfied.filter((item) => typeof item === "string")
      : [],
    gaps,
    evidence,
    notes,
  };
}

export function formatInspectionNotes(inspection: CodebaseInspection): string {
  const lines: string[] = ["Codebase Inspection:", `Summary: ${inspection.summary}`];

  if (inspection.satisfied.length > 0) {
    lines.push("Already Satisfied:", ...inspection.satisfied.map((item) => `- ${item}`));
  }

  if (inspection.gaps.length > 0) {
    lines.push("Gaps:", ...inspection.gaps.map((gap) => `- ${gap}`));
  }

  if (inspection.evidence.length > 0) {
    lines.push("Evidence:", ...inspection.evidence.map((item) => `- ${item}`));
  }

  if (inspection.notes.length > 0) {
    lines.push("Notes:", ...inspection.notes.map((note) => `- ${note}`));
  }

  return lines.join("\n");
}
