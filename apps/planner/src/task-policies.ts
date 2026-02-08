import type { Requirement } from "./parser";
import type { PlannedTaskInput, TaskGenerationResult } from "./strategies/index";

// 初期化タスクで変更を許可するルート設定ファイル
export const INIT_ALLOWED_PATHS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  "tsconfig.json",
  "tsconfig.*.json",
  ".eslintrc.*",
  ".prettierrc*",
  "biome.json",
  "turbo.json",
  "docker-compose.yml",
  "Dockerfile",
  ".env.example",
  "README.md",
  "apps/**",
  "packages/**",
];

const INIT_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  "tsconfig.json",
];

const LOCKFILE_PATHS = ["pnpm-lock.yaml"];

// docser はドキュメント整備が主務だが、package.json の scripts 補完や
// .env.example の追記など軽微なルート変更が必要になるケースを許容する
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
  const files = task.context?.files ?? [];
  if (files.some((file) => INIT_ROOT_FILES.includes(file))) {
    return true;
  }

  const allowed = task.allowedPaths ?? [];
  const rootEvidence = [...allowed, ...files].some(
    (path) =>
      INIT_ROOT_FILES.includes(path) ||
      path === "apps/" ||
      path === "packages/" ||
      path === "apps/**" ||
      path === "packages/**",
  );

  if (!rootEvidence) {
    return false;
  }

  const title = task.title.toLowerCase();
  return (
    ["init", "initialize", "bootstrap", "setup", "scaffold", "monorepo", "workspace"].some((hint) =>
      title.includes(hint),
    ) ||
    ["初期化", "セットアップ", "モノレポ", "ワークスペース"].some((hint) =>
      task.title.includes(hint),
    )
  );
}

function normalizeVerificationCommands(commands: string[]): string[] {
  return commands.map((command) => {
    return command;
  });
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

    // AIが依存追加を行う可能性があるため、全タスクで lockfile の変更を許可する
    normalized = {
      ...normalized,
      allowedPaths: mergeAllowedPaths(normalized.allowedPaths, LOCKFILE_PATHS),
    };

    return normalized;
  });

  return { ...result, tasks };
}

// テスト関連の手がかりから担当ロールを推定する
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
    /テスト(追加|作成|実装|更新|修正|強化)/,
    /フレーク|flaky/,
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

function isCheckCommand(command: string): boolean {
  return /\b(pnpm|npm)\b[^\n]*\b(run\s+)?check\b/.test(command);
}

function isDevCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(run\s+)?dev\b/.test(command);
}

function ensureDevCommand(commands: string[]): string[] {
  // `dev` は常駐プロセスになりやすく検証用途には不向きなので自動補完しない
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

function filterVerificationCommands(commands: string[], checkScriptAvailable: boolean): string[] {
  return commands.filter((command) => {
    if (isDevCommand(command)) {
      return false;
    }
    if (!checkScriptAvailable && isCheckCommand(command)) {
      return false;
    }
    return true;
  });
}

export function applyVerificationCommandPolicy(
  result: TaskGenerationResult,
  checkScriptAvailable: boolean,
): TaskGenerationResult {
  // `dev` は常に除外し、`check` はスクリプト未定義時のみ除外する
  const tasks = result.tasks.map((task) => {
    const filtered = filterVerificationCommands(task.commands, checkScriptAvailable);
    if (filtered.length === task.commands.length) {
      return task;
    }
    return { ...task, commands: filtered };
  });

  return { ...result, tasks };
}

function taskTouchesFrontend(task: PlannedTaskInput): boolean {
  const text = [task.title, task.goal, task.context?.specs, task.context?.notes]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const textHints = ["frontend", "フロント", "ui", "画面", "web"];
  if (textHints.some((hint) => text.includes(hint))) {
    return true;
  }
  const paths = [...(task.allowedPaths ?? []), ...(task.context?.files ?? [])]
    .join(" ")
    .toLowerCase();
  return /apps\/web|web\/|frontend|ui/.test(paths);
}

function hasE2ECommand(commands: string[]): boolean {
  return commands.some((command) => /\b(e2e|playwright)\b/i.test(command));
}

// フロントタスクのtesterにE2E検証を補う
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
    if (!taskTouchesFrontend(task) || hasE2ECommand(task.commands)) {
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
  return commands.some((command) => {
    const trimmed = command.trim();
    return /\bpnpm\b[^\n]*\b(install|add|i)\b/.test(trimmed);
  });
}

export function generateInitializationTasks(requirement: Requirement): TaskGenerationResult {
  const allowedPaths = mergeAllowedPaths(requirement.allowedPaths, INIT_ALLOWED_PATHS);
  const task: PlannedTaskInput = {
    title: "モノレポ構成の初期化",
    goal: "pnpm workspaces が使える状態になり、pnpm -r list が成功する",
    role: "worker",
    context: {
      files: ["package.json", "pnpm-workspace.yaml", ".gitignore", "apps/", "packages/"],
      specs: "apps/ と packages/ の土台と最小限のpackage.jsonを用意する",
      notes: requirement.goal,
    },
    allowedPaths,
    commands: ["pnpm install", "pnpm -r list"],
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
      "モノレポ構成が見つからないため初期化タスクのみ生成しました。初期化完了後にPlannerを再実行してください。",
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
      `依存関係に循環/未来参照の可能性があったため ${correctedTaskCount} 件を補正しました。`,
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
      `依存関係の冗長辺を ${removedEdgeCount} 件削除し、並列実行性を補正しました。`,
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
      // 先頭に差し込み、既存依存インデックスを1つ後ろへずらす
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
    // 初期化タスクを補った後は「初期化未タスク化」警告を残さない
    return !(warning.includes("allowedPaths") && warning.includes("タスク化していません"));
  });

  const warnings = injected
    ? [
        ...filteredWarnings,
        "リポジトリ初期化タスクを自動追加し、他タスクはその完了に依存するよう補正しました。",
      ]
    : filteredWarnings;

  return {
    ...result,
    tasks: patchedTasks,
    warnings,
  };
}

export function needsLockfileAllowance(commands: string[], allowedPaths: string[]): boolean {
  return requiresLockfile(commands) && !allowedPaths.includes("pnpm-lock.yaml");
}
