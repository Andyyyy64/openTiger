import { runResearchOrchestrationTick } from "../main/research-orchestrator";
import type { CycleManagerPlugin } from "./types";

export const tigerResearchCyclePlugin: CycleManagerPlugin = {
  id: "tiger-research",
  runMonitorTick: runResearchOrchestrationTick,
};
