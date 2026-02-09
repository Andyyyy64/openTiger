import {
  resolveRepoRoot,
  resolveRequirementPath,
  writeRequirementFile,
} from "../system-requirements";
import { parseIndexedProcessName } from "./helpers";
import { managedProcesses } from "./state";
import type { ProcessDefinition } from "./types";

// 起動可能なプロセス定義を集約する
const MAX_PLANNER_PROCESSES = 1;

function buildPlannerDefinition(index: number): ProcessDefinition {
  return {
    name: "planner",
    label: "Planner",
    description: "requirementsからタスクを生成",
    group: "Planner",
    kind: "planner",
    supportsStop: true,
    buildStart: async (payload) => {
      const requirementPath = await resolveRequirementPath(
        payload.requirementPath,
        "requirement.md",
        { allowMissing: Boolean(payload.content) },
      );
      if (payload.content) {
        await writeRequirementFile(requirementPath, payload.content);
      }
      return {
        command: "pnpm",
        args: ["--filter", "@openTiger/planner", "run", "start:fresh", requirementPath],
        cwd: resolveRepoRoot(),
        env: { AGENT_ID: `planner-${index}` },
      };
    },
  };
}

function buildJudgeDefinition(index: number): ProcessDefinition {
  const name = index === 1 ? "judge" : `judge-${index}`;
  return {
    name,
    label: index === 1 ? "Judge" : `Judge #${index}`,
    description: "レビュー判定の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/judge", "start"],
      cwd: resolveRepoRoot(),
      env: { AGENT_ID: `judge-${index}` },
    }),
  };
}

function buildWorkerRoleDefinition(
  role: "worker" | "tester" | "docser",
  index: number,
): ProcessDefinition {
  const name = `${role}-${index}`;
  const label =
    role === "docser"
      ? index === 1
        ? "Docser"
        : `Docser #${index}`
      : `${role === "worker" ? "Worker" : "Tester"} #${index}`;
  const description =
    role === "worker"
      ? "実装ワーカー"
      : role === "tester"
        ? "テスト専用ワーカー"
        : "ドキュメント更新ワーカー";
  return {
    name,
    label,
    description,
    group: "Workers",
    kind: "worker",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/worker", "run", "start:fresh"],
      cwd: resolveRepoRoot(),
      env: { WORKER_INDEX: String(index), AGENT_ROLE: role },
    }),
  };
}

function resolveDynamicProcessDefinition(name: string): ProcessDefinition | undefined {
  const judgeIndex = parseIndexedProcessName(name, "judge", { allowBaseName: true });
  if (judgeIndex !== null) {
    return buildJudgeDefinition(judgeIndex);
  }

  const workerIndex = parseIndexedProcessName(name, "worker");
  if (workerIndex !== null) {
    return buildWorkerRoleDefinition("worker", workerIndex);
  }

  const testerIndex = parseIndexedProcessName(name, "tester");
  if (testerIndex !== null) {
    return buildWorkerRoleDefinition("tester", testerIndex);
  }

  const docserIndex = parseIndexedProcessName(name, "docser");
  if (docserIndex !== null) {
    return buildWorkerRoleDefinition("docser", docserIndex);
  }

  return undefined;
}

const processDefinitions: ProcessDefinition[] = [
  buildPlannerDefinition(MAX_PLANNER_PROCESSES),
  {
    name: "dispatcher",
    label: "Dispatcher",
    description: "タスク割当の常駐プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/dispatcher", "start"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "cycle-manager",
    label: "Cycle Manager",
    description: "長時間運用の管理プロセス",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/cycle-manager", "run", "start:fresh"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-up",
    label: "Database Start",
    description: "Postgres/Redisを起動",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "up", "-d", "postgres", "redis"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-down",
    label: "Database Stop",
    description: "Postgres/Redisを停止",
    group: "Database",
    kind: "database",
    supportsStop: false,
    buildStart: async () => ({
      command: "docker",
      args: ["compose", "down"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-push",
    label: "Database Push",
    description: "スキーマを反映",
    group: "Database",
    kind: "command",
    supportsStop: false,
    buildStart: async () => ({
      command: "pnpm",
      args: ["db:push"],
      cwd: resolveRepoRoot(),
    }),
  },
];

const processDefinitionMap = new Map(
  processDefinitions.map((definition) => [definition.name, definition]),
);

export function resolveProcessDefinition(name: string): ProcessDefinition | undefined {
  return processDefinitionMap.get(name) ?? resolveDynamicProcessDefinition(name);
}

export function listProcessDefinitions(): ProcessDefinition[] {
  const definitions = new Map<string, ProcessDefinition>();
  for (const definition of processDefinitions) {
    definitions.set(definition.name, definition);
  }

  for (const processName of managedProcesses.keys()) {
    if (definitions.has(processName)) {
      continue;
    }
    const dynamic = resolveDynamicProcessDefinition(processName);
    if (dynamic) {
      definitions.set(dynamic.name, dynamic);
    }
  }

  return Array.from(definitions.values());
}
