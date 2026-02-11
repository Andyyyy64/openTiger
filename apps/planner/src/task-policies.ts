import type { Requirement } from "./parser";
import type { PlannedTaskInput, TaskGenerationResult } from "./strategies/index";

// Root config files allowed for modification by initialization tasks
export const INIT_ALLOWED_PATHS = [
  ".gitignore",
  "README.md",
  "docs/**",
  "scripts/**",
];

const INIT_ROOT_FILES = [
  "Makefile",
  "package.json",
  "pnpm-workspace.yaml",
  "yarn-workspace.yaml",
  "workspace.json",
  "workspaces.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".gitignore",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
];

const LOCKFILE_PATHS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

// docser focuses on documentation but may need minor root changes (e.g. package.json scripts, .env.example)
export const DOCSER_ALLOWED_PATHS = [
  "docs/**",
  "ops/**",
  "README.md",
  "package.json",
  ".env.example",
];

function mergeAllowedPaths(current: string[], extra: string[]): string[] {
  const seen = new Set(current);
  const merged = [...current];

  for (const path of extra) {
    if (!seen.has(path)) {
      merged.push(path);
      seen.add(path);
    }
  }

  return merged;
}

function isInitializationTask(task: PlannedTaskInput): boolean {
  const title = task.title.toLowerCase();
  const hasInitKeyword =
    ["init", "initialize", "bootstrap", "setup", "scaffold", "workspace", "foundation"].some(
      (hint) => title.includes(hint),
    ) || ["init", "setup", "bootstrap", "foundation"].some((hint) => task.title.toLowerCase().includes(hint));
  if (hasInitKeyword) {
    return true;
  }

  const files = task.context?.files ?? [];
  if (files.some((file) => INIT_ROOT_FILES.includes(file))) {
    return true;
  }
  return false;
}

function normalizeVerificationCommands(commands: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeGeneratedTasks(result: TaskGenerationResult): TaskGenerationResult {
  const tasks = result.tasks.map((task) => {
    let normalized: PlannedTaskInput = { ...task };
    const normalizedCommands = normalizeVerificationCommands(task.commands);

    if (normalizedCommands !== task.commands) {
      normalized = { ...normalized, commands: normalizedCommands };
    }

    if (isInitializationTask(task)) {
      normalized = {
        ...normalized,
        allowedPaths: mergeAllowedPaths(task.allowedPaths, INIT_ALLOWED_PATHS),
      };
    }

    // Allow lockfile changes for all tasks since AI may add dependencies
    normalized = {
      ...normalized,
      allowedPaths: mergeAllowedPaths(normalized.allowedPaths, LOCKFILE_PATHS),
    };

    return normalized;
  });

  return { ...result, tasks };
}

// Infer role from test-related clues
function inferTaskRole(task: PlannedTaskInput): "worker" | "tester" {
  const hintText = [task.title, task.goal, task.context?.specs, task.context?.notes]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const testerPatterns = [
    /\be2e\b/,
    /\bplaywright\b/,
    /\bvitest\b/,
    /\bcypress\b/,
    /\btest(s)?\s*(add|create|write|implement|update|fix)\b/,
    /test\s*(add|creat|implement|updat|fix|strengthen)/i,
    /flak|flaky/i,
  ];
  if (testerPatterns.some((pattern) => pattern.test(hintText))) {
    return "tester";
  }

  const pathHints = [...(task.allowedPaths ?? []), ...(task.context?.files ?? [])]
    .join(" ")
    .toLowerCase();
  if (/(test|__tests__|spec|playwright|e2e)/.test(pathHints)) {
    return "tester";
  }

  return "worker";
}

export function applyTaskRolePolicy(result: TaskGenerationResult): TaskGenerationResult {
  const tasks = result.tasks.map((task) => {
    if (task.role) {
      return task;
    }
    return { ...task, role: inferTaskRole(task) };
  });
  return { ...result, tasks };
}

function ensureDevCommand(commands: string[]): string[] {
  // Do not auto-suggest dev; it tends to be a long-running process and is poor for verification
  return commands;
}

export function applyDevCommandPolicy(
  result: TaskGenerationResult,
  devCommand?: string,
): TaskGenerationResult {
  if (!devCommand) {
    return result;
  }
  const tasks = result.tasks.map((task) => {
    const updatedCommands = ensureDevCommand(task.commands);
    if (updatedCommands === task.commands) {
      return task;
    }
    return { ...task, commands: updatedCommands };
  });
  return { ...result, tasks };
}

export function applyVerificationCommandPolicy(
  result: TaskGenerationResult,
  _checkScriptAvailable: boolean,
): TaskGenerationResult {
  // Normalize command strings and drop duplicates/empties
  const tasks = result.tasks.map((task) => {
    const filtered = normalizeVerificationCommands(task.commands);
    if (filtered.length === task.commands.length) {
      return task;
    }
    return { ...task, commands: filtered };
  });

  return { ...result, tasks };
}

function taskRequiresE2E(task: PlannedTaskInput): boolean {
  const text = [task.title, task.goal, task.context?.specs, task.context?.notes]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const explicitE2ePatterns = [
    /\be2e\b/,
    /\bplaywright\b/,
    /\bcypress\b/,
    /critical path/,
    /user flow/,
    /e2e|end-?to-?end/i,
    /critical\s*path/i,
    /user\s*flow/i,
  ];
  if (explicitE2ePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }
  const paths = [...(task.allowedPaths ?? []), ...(task.context?.files ?? [])]
    .join(" ")
    .toLowerCase();
  return /(^|\/)(__e2e__|e2e|playwright|cypress)(\/|$)|test-results/.test(paths);
}

function hasE2ECommand(commands: string[]): boolean {
  return commands.some((command) => /\b(e2e|playwright|cypress)\b/i.test(command));
}

// Add E2E verification only to tester tasks with explicit E2E requirements
export function applyTesterCommandPolicy(
  result: TaskGenerationResult,
  e2eCommand?: string,
): TaskGenerationResult {
  if (!e2eCommand) {
    return result;
  }
  const tasks = result.tasks.map((task) => {
    if (task.role !== "tester") {
      return task;
    }
    if (!taskRequiresE2E(task) || hasE2ECommand(task.commands)) {
      return task;
    }
    return {
      ...task,
      commands: [...task.commands, e2eCommand],
    };
  });
  return { ...result, tasks };
}

function requiresLockfile(commands: string[]): boolean {
  const installTokens = new Set(
    (process.env.PLANNER_INSTALL_SUBCOMMAND_TOKENS ?? "install,add,i")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );

  return commands.some((command) => {
    const tokens = command
      .trim()
      .split(/\s+/)
      .map((token) => token.toLowerCase());
    return tokens.some((token) => installTokens.has(token));
  });
}

export function generateInitializationTasks(requirement: Requirement): TaskGenerationResult {
  const allowedPaths = mergeAllowedPaths(requirement.allowedPaths, INIT_ALLOWED_PATHS);
  const bootstrapTargets =
    requirement.allowedPaths.length > 0 ? requirement.allowedPaths.slice(0, 8) : ["README.md"];
  const task: PlannedTaskInput = {
    title: "Initialize repository foundation",
    goal:
      "Create the minimum project foundation within allowed paths so follow-up tasks can proceed.",
    role: "worker",
    context: {
      files: bootstrapTargets,
      specs:
        "For an empty repository, create the minimum directory/build foundation aligned with In Scope requirements.",
      notes: requirement.goal,
    },
    allowedPaths,
    commands: [],
    priority: 100,
    riskLevel: "low",
    dependencies: [],
    dependsOnIndexes: [],
    timeboxMinutes: 90,
    targetArea: undefined,
    touches: [],
  };

  return {
    tasks: [task],
    warnings: [
      "Repository is empty, so only an initialization task was generated. Re-run Planner after initialization.",
    ],
    totalEstimatedMinutes: task.timeboxMinutes ?? 45,
  };
}

export function sanitizeTaskDependencyIndexes(result: TaskGenerationResult): TaskGenerationResult {
  let correctedTaskCount = 0;

  const tasks = result.tasks.map((task, index) => {
    const raw = task.dependsOnIndexes ?? [];
    const normalized = Array.from(
      new Set(
        raw.filter(
          (dep) =>
            Number.isInteger(dep) &&
            dep >= 0 &&
            dep < result.tasks.length &&
            dep !== index &&
            dep < index,
        ),
      ),
    );

    if (normalized.length === raw.length) {
      return task;
    }

    correctedTaskCount++;
    return {
      ...task,
      dependsOnIndexes: normalized,
    };
  });

  if (correctedTaskCount === 0) {
    return result;
  }

  return {
    ...result,
    tasks,
    warnings: [
      ...result.warnings,
      `Corrected ${correctedTaskCount} dependency(ies) for possible cycles or forward references.`,
    ],
  };
}

export function reduceRedundantDependencyIndexes(
  result: TaskGenerationResult,
): TaskGenerationResult {
  if (result.tasks.length <= 1) {
    return result;
  }

  const tasks = result.tasks.map((task) => ({
    ...task,
    dependsOnIndexes: [...(task.dependsOnIndexes ?? [])],
  }));

  const canReach = (from: number, target: number, visited: Set<number>): boolean => {
    if (from === target) {
      return true;
    }
    const deps = tasks[from]?.dependsOnIndexes ?? [];
    for (const dep of deps) {
      if (dep === target) {
        return true;
      }
      if (visited.has(dep)) {
        continue;
      }
      visited.add(dep);
      if (canReach(dep, target, visited)) {
        return true;
      }
    }
    return false;
  };

  let removedEdgeCount = 0;

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (!task) continue;
    const deps = Array.from(new Set(task.dependsOnIndexes ?? [])).sort((a, b) => a - b);
    if (deps.length <= 1) {
      continue;
    }

    const reduced = deps.filter((candidate) => {
      for (const other of deps) {
        if (other === candidate) {
          continue;
        }
        if (canReach(other, candidate, new Set([other]))) {
          return false;
        }
      }
      return true;
    });

    removedEdgeCount += deps.length - reduced.length;
    task.dependsOnIndexes = reduced;
  }

  if (removedEdgeCount === 0) {
    return result;
  }

  return {
    ...result,
    tasks,
    warnings: [
      ...result.warnings,
      `Removed ${removedEdgeCount} redundant dependency edge(s) to improve parallelism.`,
    ],
  };
}

export function ensureInitializationTaskForUninitializedRepo(
  result: TaskGenerationResult,
  requirement: Requirement,
  repoUninitialized: boolean,
): TaskGenerationResult {
  if (!repoUninitialized) {
    return result;
  }

  let tasks = [...result.tasks];
  let initTaskIndex = tasks.findIndex((task) => isInitializationTask(task));
  let injected = false;

  if (initTaskIndex === -1) {
    const bootstrapTask = generateInitializationTasks(requirement).tasks[0];
    if (bootstrapTask) {
      // Prepend and shift existing dependency indexes by one
      const shiftedTasks = tasks.map((task) => ({
        ...task,
        dependsOnIndexes: (task.dependsOnIndexes ?? []).map((dep) => dep + 1),
      }));
      tasks = [bootstrapTask, ...shiftedTasks];
      initTaskIndex = 0;
      injected = true;
    }
  }

  if (initTaskIndex === -1) {
    return result;
  }

  const patchedTasks = tasks.map((task, index) => {
    if (index === initTaskIndex || isInitializationTask(task)) {
      return task;
    }

    const currentDepends = task.dependsOnIndexes ?? [];
    if (currentDepends.includes(initTaskIndex)) {
      return task;
    }

    const nextDepends = [...currentDepends, initTaskIndex].filter((dep) => dep < index);

    return {
      ...task,
      dependsOnIndexes: Array.from(new Set(nextDepends)),
    };
  });

  const filteredWarnings = result.warnings.filter((warning) => {
    // Drop "init not taskified" warning after injecting init task
    return !(warning.includes("allowedPaths") && warning.includes("not taskified"));
  });

  const warnings = injected
    ? [
        ...filteredWarnings,
        "Injected repository initialization task; other tasks now depend on it.",
      ]
    : filteredWarnings;

  return {
    ...result,
    tasks: patchedTasks,
    warnings,
  };
}

export function needsLockfileAllowance(commands: string[], allowedPaths: string[]): boolean {
  return requiresLockfile(commands) && !allowedPaths.some((path) => LOCKFILE_PATHS.includes(path));
}
