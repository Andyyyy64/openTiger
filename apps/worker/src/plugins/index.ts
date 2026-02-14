import { tigerResearchWorkerPlugin } from "./tiger-research";
import type { WorkerTaskKindPlugin } from "./types";

const taskKindPlugins = new Map<string, WorkerTaskKindPlugin>(
  [tigerResearchWorkerPlugin].map((plugin) => [plugin.kind, plugin]),
);

export function resolveWorkerTaskKindPlugin(kind: string): WorkerTaskKindPlugin | undefined {
  return taskKindPlugins.get(kind);
}
