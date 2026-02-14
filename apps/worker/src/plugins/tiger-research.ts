import { resolveResearchInstructionsPathFromTask } from "../research/instructions";
import { runResearchWorker } from "../research/runner";
import type { WorkerTaskKindPlugin } from "./types";

export const tigerResearchWorkerPlugin: WorkerTaskKindPlugin = {
  kind: "research",
  resolveInstructionsPath: (task, fallbackPath) =>
    resolveResearchInstructionsPathFromTask(task) ?? fallbackPath,
  run: (params) => runResearchWorker(params),
};
