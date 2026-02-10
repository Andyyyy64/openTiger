import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { getPlannerOpenCodeEnv } from "./opencode-config";
import { generateAndParseWithRetry } from "./llm-json-retry";
import type { Requirement } from "./parser";
import type { PlannedTaskInput, TaskGenerationResult } from "./strategies";

type VerificationContractRule = {
  whenChangedAny?: string[];
  whenChangedAll?: string[];
  commands: string[];
};

type VerificationContract = {
  commands?: string[];
  byRole?: Record<string, string[]>;
  rules?: VerificationContractRule[];
};

type VerificationPlanPayload = {
  commands: string[];
  warnings?: string[];
};

type PlannerVerificationMode = "off" | "fallback" | "contract" | "llm" | "hybrid";

type AugmentVerificationCommandsOptions = {
  workdir: string;
  requirement: Requirement;
  result: TaskGenerationResult;
};

const DEFAULT_VERIFY_CONTRACT_PATH = ".opentiger/verify.contract.json";
const DEFAULT_MAX_COMMANDS = 4;
const DEFAULT_PLAN_TIMEOUT_SECONDS = 120;
const SHELL_CONTROL_PATTERN = /&&|\|\||[|;&<>`]/;
const MAX_PACKAGE_CONTEXT = 12;
const MAX_SCRIPT_CONTEXT = 20;

function parseMode(raw: string | undefined): PlannerVerificationMode {
  const normalized = (raw ?? "hybrid").trim().toLowerCase();
  if (normalized === "off" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "fallback") {
    return "fallback";
  }
  if (normalized === "contract") {
    return "contract";
  }
  if (normalized === "llm") {
    return "llm";
  }
  return "hybrid";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function stripWildcards(path: string): string {
  return normalizePath(path).replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/+$/, "");
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPath || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern.includes("*")) {
    const base = stripWildcards(normalizedPattern);
    if (!base) {
      return true;
    }
    return normalizedPath.startsWith(base) || base.startsWith(normalizedPath);
  }

  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`) ||
    normalizedPattern.startsWith(`${normalizedPath}/`)
  );
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isRunnableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (SHELL_CONTROL_PATTERN.test(trimmed)) {
    return false;
  }

  const tokens = tokenizeCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return false;
  }

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      break;
    }
    index += 1;
  }

  return Boolean(tokens[index]);
}

function dedupeCommands(commands: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }

  return deduped;
}

function sanitizeCommands(commands: string[], maxCommands: number): string[] {
  return dedupeCommands(commands)
    .filter((command) => isRunnableCommand(command))
    .slice(0, maxCommands);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerificationContract(value: unknown): value is VerificationContract {
  if (!isRecord(value)) {
    return false;
  }

  const commandsOk = value.commands === undefined || Array.isArray(value.commands);
  const byRoleOk = value.byRole === undefined || isRecord(value.byRole);
  const rulesOk = value.rules === undefined || Array.isArray(value.rules);

  return commandsOk && byRoleOk && rulesOk;
}

function collectTaskPathHints(task: PlannedTaskInput): string[] {
  const hints = [...(task.context?.files ?? []), ...(task.allowedPaths ?? [])].map((path) =>
    normalizePath(path),
  );
  return Array.from(new Set(hints.filter((hint) => hint.length > 0)));
}

function ruleMatchesTask(rule: VerificationContractRule, taskPathHints: string[]): boolean {
  const whenAny = rule.whenChangedAny ?? [];
  const whenAll = rule.whenChangedAll ?? [];

  const anyMatched =
    whenAny.length === 0 ||
    taskPathHints.some((path) => whenAny.some((pattern) => pathMatchesPattern(path, pattern)));

  const allMatched = whenAll.every((pattern) =>
    taskPathHints.some((path) => pathMatchesPattern(path, pattern)),
  );

  return anyMatched && allMatched;
}

function resolveContractCommandsForTask(
  contract: VerificationContract,
  task: PlannedTaskInput,
): string[] {
  const role = task.role ?? "worker";
  const taskPathHints = collectTaskPathHints(task);
  const commands: string[] = [];

  commands.push(...toStringArray(contract.commands));

  if (isRecord(contract.byRole)) {
    commands.push(...toStringArray(contract.byRole[role]));
  }

  if (Array.isArray(contract.rules)) {
    for (const rawRule of contract.rules) {
      if (!isRecord(rawRule)) {
        continue;
      }
      const rule: VerificationContractRule = {
        whenChangedAny: toStringArray(rawRule.whenChangedAny),
        whenChangedAll: toStringArray(rawRule.whenChangedAll),
        commands: toStringArray(rawRule.commands),
      };
      if (rule.commands.length === 0) {
        continue;
      }
      if (!ruleMatchesTask(rule, taskPathHints)) {
        continue;
      }
      commands.push(...rule.commands);
    }
  }

  return commands;
}

async function loadVerificationContract(workdir: string): Promise<VerificationContract | null> {
  const relativePath =
    process.env.PLANNER_VERIFY_CONTRACT_PATH?.trim() || DEFAULT_VERIFY_CONTRACT_PATH;
  const contractPath = join(workdir, relativePath);

  if (!(await pathExists(contractPath))) {
    return null;
  }

  try {
    const raw = await readFile(contractPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isVerificationContract(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadRootScripts(workdir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function loadPackageScriptsForTask(
  workdir: string,
  task: PlannedTaskInput,
): Promise<Array<{ packagePath: string; packageName?: string; scripts: Record<string, string> }>> {
  const contextFiles = task.context?.files ?? [];
  const packageMap = new Map<
    string,
    { packagePath: string; packageName?: string; scripts: Record<string, string> }
  >();

  for (const rawFile of contextFiles) {
    const normalized = normalizePath(rawFile);
    if (!normalized || normalized.includes("*")) {
      continue;
    }
    let current = resolve(workdir, normalized);
    if (!current.startsWith(resolve(workdir))) {
      continue;
    }
    current = dirname(current);

    while (current.startsWith(resolve(workdir))) {
      const packageJsonPath = join(current, "package.json");
      if (await pathExists(packageJsonPath)) {
        try {
          const raw = await readFile(packageJsonPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            name?: string;
            scripts?: Record<string, string>;
          };
          const key = current;
          if (!packageMap.has(key)) {
            packageMap.set(key, {
              packagePath: normalizePath(relative(workdir, current)) || ".",
              packageName: typeof parsed.name === "string" ? parsed.name : undefined,
              scripts: (parsed.scripts ?? {}) as Record<string, string>,
            });
          }
        } catch {
          // ignore malformed package json and continue
        }
        break;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    if (packageMap.size >= MAX_PACKAGE_CONTEXT) {
      break;
    }
  }

  return Array.from(packageMap.values()).slice(0, MAX_PACKAGE_CONTEXT);
}

function normalizeScriptContext(scripts: Record<string, string>): Record<string, string> {
  const entries = Object.entries(scripts)
    .map(([name, command]) => [name, command.trim()] as const)
    .filter(([, command]) => command.length > 0)
    .slice(0, MAX_SCRIPT_CONTEXT);

  return Object.fromEntries(entries);
}

function isVerificationPlanPayload(value: unknown): value is VerificationPlanPayload {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.commands);
}

function buildTaskVerificationPrompt(params: {
  requirement: Requirement;
  task: PlannedTaskInput;
  rootScripts: Record<string, string>;
  packageContexts: Array<{
    packagePath: string;
    packageName?: string;
    scripts: Record<string, string>;
  }>;
  maxCommands: number;
}): string {
  const payload = {
    requirementGoal: params.requirement.goal,
    task: {
      title: params.task.title,
      goal: params.task.goal,
      role: params.task.role ?? "worker",
      allowedPaths: params.task.allowedPaths ?? [],
      files: params.task.context?.files ?? [],
      existingCommands: params.task.commands ?? [],
      notes: params.task.context?.notes,
    },
    rootScripts: normalizeScriptContext(params.rootScripts),
    relatedPackages: params.packageContexts.map((entry) => ({
      packagePath: entry.packagePath,
      packageName: entry.packageName,
      scripts: normalizeScriptContext(entry.scripts),
    })),
  };

  return [
    "You are a planner that proposes deterministic verification commands for a single task.",
    "Return JSON only with this schema:",
    '{"commands":["string"],"warnings":["string"]}',
    "Rules:",
    "- Commands must be non-interactive and complete without manual input.",
    "- Do not use shell control operators.",
    "- Prefer existing repository scripts from the provided context.",
    `- Return at most ${params.maxCommands} commands.`,
    "- If no suitable command exists, return an empty commands array.",
    "Context:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

async function planCommandsWithLlm(params: {
  workdir: string;
  requirement: Requirement;
  task: PlannedTaskInput;
  maxCommands: number;
}): Promise<string[]> {
  const rootScripts = await loadRootScripts(params.workdir);
  const packageContexts = await loadPackageScriptsForTask(params.workdir, params.task);
  const prompt = buildTaskVerificationPrompt({
    requirement: params.requirement,
    task: params.task,
    rootScripts,
    packageContexts,
    maxCommands: params.maxCommands,
  });

  const model = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";
  const timeoutSeconds = parsePositiveInt(
    process.env.PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS,
    DEFAULT_PLAN_TIMEOUT_SECONDS,
  );

  const parsed = await generateAndParseWithRetry<VerificationPlanPayload>({
    workdir: params.workdir,
    model,
    prompt,
    timeoutSeconds,
    env: getPlannerOpenCodeEnv(),
    guard: isVerificationPlanPayload,
    label: `Planner verification command generation: ${params.task.title}`,
  });

  return sanitizeCommands(toStringArray(parsed.commands), params.maxCommands);
}

export async function augmentVerificationCommandsForTasks(
  options: AugmentVerificationCommandsOptions,
): Promise<TaskGenerationResult> {
  const mode = parseMode(process.env.PLANNER_VERIFY_COMMAND_MODE);
  if (mode === "off") {
    return options.result;
  }

  const maxCommands = parsePositiveInt(
    process.env.PLANNER_VERIFY_MAX_COMMANDS,
    DEFAULT_MAX_COMMANDS,
  );
  const augmentNonEmpty =
    (process.env.PLANNER_VERIFY_AUGMENT_NONEMPTY ?? "false").toLowerCase() === "true";
  const contract = await loadVerificationContract(options.workdir);
  const warnings = [...options.result.warnings];

  const tasks: PlannedTaskInput[] = [];
  for (const task of options.result.tasks) {
    const originalCommands = sanitizeCommands(task.commands ?? [], maxCommands);
    let merged = [...originalCommands];
    const shouldResolve = augmentNonEmpty || merged.length === 0;

    if (shouldResolve && (mode === "contract" || mode === "hybrid" || mode === "fallback")) {
      if (contract) {
        const contractCommands = sanitizeCommands(
          resolveContractCommandsForTask(contract, task),
          maxCommands,
        );
        merged = dedupeCommands([...merged, ...contractCommands]).slice(0, maxCommands);
      }
    }

    if (
      shouldResolve &&
      merged.length === 0 &&
      (mode === "llm" || mode === "hybrid" || mode === "fallback")
    ) {
      try {
        const llmCommands = await planCommandsWithLlm({
          workdir: options.workdir,
          requirement: options.requirement,
          task,
          maxCommands,
        });
        merged = dedupeCommands([...merged, ...llmCommands]).slice(0, maxCommands);
      } catch (error) {
        warnings.push(
          `Task "${task.title}": verification command planning failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    if (merged.length === 0) {
      warnings.push(
        `Task "${task.title}": verification commands unresolved. Worker auto verification strategy will be used.`,
      );
    }

    tasks.push({
      ...task,
      commands: merged,
    });
  }

  return {
    ...options.result,
    tasks,
    warnings: dedupeCommands(warnings),
  };
}
