export type PluginApiVersion = "1";

export type ApiHookContext = {
  route: (path: string, routeOrApp: unknown) => unknown;
};

export type ApiHook = {
  routeBasePath?: string;
  registerRoutes?: (context: ApiHookContext) => void;
};

export type PlannerHookHandleJobParams = {
  jobId: string;
  config: unknown;
  agentId: string;
};

export type PlannerHook = {
  mode?: "planner-first" | "task-first";
  handleJob?: (params: PlannerHookHandleJobParams) => Promise<void>;
};

export type DispatcherHook = {
  laneHints?: string[];
};

export type WorkerTaskLike = {
  id: string;
  kind: string;
  title: string;
  goal: string;
  context?: unknown;
};

export type WorkerRunResult = {
  success: boolean;
  taskId: string;
  runId?: string;
  prUrl?: string;
  error?: string;
  costTokens?: number;
};

export type WorkerTaskKindHandler = {
  kind: string;
  resolveInstructionsPath?: (task: WorkerTaskLike, fallbackPath?: string) => string | undefined;
  run: (params: {
    task: WorkerTaskLike;
    runId: string;
    agentId: string;
    workspacePath: string;
    model?: string;
    instructionsPath?: string;
  }) => Promise<WorkerRunResult>;
};

export type WorkerHook = {
  taskKind?: string;
  taskKindHandlers?: WorkerTaskKindHandler[];
};

export type JudgeHookPendingTarget = {
  taskId: string;
  runId: string;
};

export type JudgeHookEvaluationResult = {
  verdict: "approve" | "request_changes";
  reasons: string[];
  suggestions?: string[];
  data?: unknown;
};

export type JudgeHook = {
  reviewMode?: string;
  collectPendingTargets?: () => Promise<JudgeHookPendingTarget[]>;
  evaluateTarget?: (target: JudgeHookPendingTarget) => Promise<JudgeHookEvaluationResult>;
  applyVerdict?: (params: {
    target: JudgeHookPendingTarget;
    result: JudgeHookEvaluationResult;
    agentId: string;
    dryRun: boolean;
  }) => Promise<void>;
};

export type CycleManagerHook = {
  monitorTick?: boolean;
  runMonitorTick?: () => Promise<void>;
  hasBacklog?: () => Promise<boolean>;
};

export type DashboardHook = {
  entryPath: string;
};

export type DbHook = {
  schemaNamespace: string;
  migrationDir?: string;
};

export type PluginManifestV1 = {
  id: string;
  name: string;
  description: string;
  version: string;
  pluginApiVersion: PluginApiVersion | string;
  taskKinds: readonly string[];
  lanes: readonly string[];
  requires?: readonly string[];
  api?: ApiHook;
  planner?: PlannerHook;
  dispatcher?: DispatcherHook;
  worker?: WorkerHook;
  judge?: JudgeHook;
  cycleManager?: CycleManagerHook;
  dashboard?: DashboardHook;
  db?: DbHook;
};

export function definePluginManifest(manifest: PluginManifestV1): PluginManifestV1 {
  return manifest;
}

export function getManifestCapabilities(manifest: PluginManifestV1): string[] {
  const capabilities: string[] = [];
  if (manifest.api) {
    capabilities.push("api");
  }
  if (manifest.planner) {
    capabilities.push("planner");
  }
  if (manifest.dispatcher) {
    capabilities.push("dispatcher");
  }
  if (manifest.worker) {
    capabilities.push("worker");
  }
  if (manifest.judge) {
    capabilities.push("judge");
  }
  if (manifest.cycleManager) {
    capabilities.push("cycleManager");
  }
  if (manifest.dashboard) {
    capabilities.push("dashboard");
  }
  if (manifest.db) {
    capabilities.push("db");
  }
  return capabilities;
}
