import {
  CANONICAL_REQUIREMENT_PATH,
  resolveRequirementRepoRoot,
  resolveRequirementPath,
  resolveRepoRoot,
  syncRequirementSnapshot,
} from "../system-requirements";
import { ensureConfigRow } from "../../config-store";
import { parseIndexedProcessName } from "./helpers";
import { managedProcesses } from "./state";
import type { ProcessDefinition } from "./types";

// Process definitions that can be started
const MAX_PLANNER_PROCESSES = 1;
function buildPlannerDefinition(index: number): ProcessDefinition {
  return {
    name: "planner",
    label: "Planner",
    description: "Generate tasks from requirements",
    group: "Planner",
    kind: "planner",
    supportsStop: true,
    buildStart: async (payload) => {
      const configRow = await ensureConfigRow();
      const effectiveRequirementRepoRoot = await resolveRequirementRepoRoot({
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
        payload.requirementPath,
        CANONICAL_REQUIREMENT_PATH,
        {
          allowMissing: Boolean(payload.content),
          repoRoot: effectiveRequirementRepoRoot,
        },
      );
      if (payload.content) {
        await syncRequirementSnapshot({
          inputPath: payload.requirementPath,
          content: payload.content,
          commitSnapshot: true,
          repoRoot: effectiveRequirementRepoRoot,
        });
      }
      return {
        command: "pnpm",
        args: ["--filter", "@openTiger/planner", "run", "start", requirementPath],
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
    description: "Resident review process",
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
      ? "Implementation worker"
      : role === "tester"
        ? "Test-only worker"
        : "Documentation update worker";
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
      args: ["--filter", "@openTiger/worker", "run", "start"],
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
    description: "Resident task dispatch process",
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
    description: "Long-running management process",
    group: "Core",
    kind: "service",
    supportsStop: true,
    autoRestart: true,
    buildStart: async () => ({
      command: "pnpm",
      args: ["--filter", "@openTiger/cycle-manager", "run", "start"],
      cwd: resolveRepoRoot(),
    }),
  },
  {
    name: "db-up",
    label: "Database Start",
    description: "Start Postgres/Redis",
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
    description: "Stop Postgres/Redis",
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
    description: "Apply schema",
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
