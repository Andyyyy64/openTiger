import { definePluginManifest } from "@openTiger/plugin-sdk";
import {
  hasResearchOrchestrationBacklog,
  runResearchOrchestrationTick,
} from "./cycle/orchestrator";
import { tigerResearchJudgeHook } from "./judge/review";
import { tigerResearchPluginManifestCore } from "./manifest";
import { handleResearchPlanningJob } from "./planner/job";

export const tigerResearchPluginManifest = definePluginManifest({
  ...tigerResearchPluginManifestCore,
  api: {
    routeBasePath: "/plugins/tiger-research",
  },
  planner: {
    mode: "planner-first",
    handleJob: handleResearchPlanningJob,
  },
  worker: {
    taskKind: "research",
  },
  judge: tigerResearchJudgeHook,
  cycleManager: {
    monitorTick: true,
    runMonitorTick: runResearchOrchestrationTick,
    hasBacklog: hasResearchOrchestrationBacklog,
  },
});

export * from "./db";
export * from "./manifest";
